import type { getApprovalAuditState } from "#harness/approval-candidates.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import { authorizationEventFields } from "#harness/authorization-event-fields.js";
import {
  createApprovalCandidateEvent,
  createApprovalSettledEvent,
  createAuthorizationCompletedEvent,
  createContextClearedEvent,
  createSessionWaitingEvent,
  createTurnCancelledEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import {
  isSettledCallStatus,
  openInputs,
  openSignIns,
  turnCoordinates,
  type SessionCall,
  type SessionInput,
  type SessionProjection,
} from "#protocol/session-projection.js";
import { callStopped, inputWithdrawn, signInWithdrawn, type StopReason } from "./events.js";

// The session's lifecycle transitions. Each reads the projection and returns the events that
// report what changed; `commit` publishes them, the publish sink folds them into the projection,
// and records whose owner the projection then shows closed are dropped. A transition never
// changes a record directly, so nothing closes without readers hearing it.
//
// Transitions are pure: what they need from effects (the requests a session relays, the time)
// arrives in their input.

/** What a transition sees: the projection, and which open requests this session relays. */
export interface SessionView {
  readonly projection: SessionProjection;
  /** Requests this session relays for a child session or a workflow run, by `requestId`. */
  readonly relayedRequestIds: ReadonlySet<string>;
}

/** Requests this session asked itself and still awaits; relayed requests answer elsewhere. */
export function ownOpenRequestIds(view: SessionView): ReadonlySet<string> {
  return new Set(
    openInputs(view.projection)
      .filter(
        (input) =>
          input.callId === undefined &&
          input.taskId === undefined &&
          !view.relayedRequestIds.has(input.request.requestId),
      )
      .map((input) => input.request.requestId),
  );
}

/**
 * `session.cancel()`: the open turn ends cancelled. Its requests, its sign-ins, and every
 * relayed request are withdrawn, since the cancel stops the work that asked them; its unsettled
 * calls are stopped. Requests earlier turns parked on stay answerable.
 */
export function cancel(view: SessionView): readonly UnstampedMessageStreamEvent[] {
  const { projection } = view;
  const turnId = projection.activeTurnId;
  const owned = (input: SessionInput) =>
    input.turnId === turnId ||
    view.relayedRequestIds.has(input.request.requestId) ||
    input.request.kind === "session-limit";
  const events: UnstampedMessageStreamEvent[] = [
    ...openInputs(projection).filter(owned).map(inputWithdrawn),
    ...openSignIns(projection)
      .filter((attempt) => attempt.turnId === turnId)
      .map((attempt) => signInWithdrawn(attempt, "The turn was cancelled.")),
  ];
  if (turnId !== undefined) {
    const { sequence } = turnCoordinates(projection);
    events.push(
      ...stoppedCalls(projection, (call) => call.turnId === turnId, sequence, "TURN_CANCELLED"),
      createTurnCancelledEvent({ sequence, turnId }),
    );
  }
  events.push(createSessionWaitingEvent());
  return events;
}

/**
 * `session.clear()`: everything the cleared history asked for is withdrawn, its approvals and
 * the session-limit prompt and every sign-in, and the calls awaiting them stop. Requests relayed
 * from live tasks stay: clearing doesn't stop the work that asked them.
 */
export function clear(
  view: SessionView,
  input: { readonly sessionId: string },
): readonly UnstampedMessageStreamEvent[] {
  const { projection } = view;
  const { sequence, turnId } = turnCoordinates(projection);
  return [
    ...openInputs(projection)
      .filter((open) => !view.relayedRequestIds.has(open.request.requestId))
      .map(inputWithdrawn),
    ...openSignIns(projection).map((attempt) =>
      signInWithdrawn(attempt, "The context was cleared."),
    ),
    ...stoppedCalls(projection, () => true, sequence, "CONTEXT_CLEARED"),
    createContextClearedEvent({ sequence, sessionId: input.sessionId, turnId }),
    createSessionWaitingEvent(),
  ];
}

/**
 * A task or workflow run ended, on its own or cancelled: nobody can answer what it relayed, so
 * each request still open is withdrawn.
 */
export function finishRun(
  view: SessionView,
  run: { readonly taskId?: string; readonly requestIds?: Iterable<string> },
): readonly UnstampedMessageStreamEvent[] {
  const ids = new Set(run.requestIds);
  return openInputs(view.projection)
    .filter(
      (input) =>
        ids.has(input.request.requestId) ||
        (run.taskId !== undefined && input.taskId === run.taskId),
    )
    .map(inputWithdrawn);
}

/** A sign-in stops the calls that need it: each settles `cancelled` until the sign-in completes. */
export function stopForSignIn(
  projection: SessionProjection,
  callIds: readonly string[],
): readonly UnstampedMessageStreamEvent[] {
  const stopped = new Set(callIds);
  return stoppedCalls(
    projection,
    (call) => stopped.has(call.callId),
    turnCoordinates(projection).sequence,
    "AUTHORIZATION_REQUIRED",
  );
}

/** Calls the projection shows unsettled, other than task calls, which settle with their task. */
function stoppedCalls(
  projection: SessionProjection,
  select: (call: SessionCall) => boolean,
  sequence: number,
  reason: StopReason,
): readonly UnstampedMessageStreamEvent[] {
  return Object.values(projection.calls)
    .filter((call) => !isSettledCallStatus(call.status) && call.taskId === undefined)
    .filter(select)
    .map((call) => callStopped(call, projection.turns[call.turnId]?.sequence ?? sequence, reason));
}

/**
 * Responder progress on approvals: candidates that started or finished, approvals they settled,
 * and the sign-in of a candidate that expired. Each is reported once, when the projection hasn't
 * heard it, for requests the projection still holds.
 */
export function reportApprovalProgress(
  projection: SessionProjection,
  audit: ReturnType<typeof getApprovalAuditState>,
  challenges: readonly AuthorizationChallenge[],
): readonly UnstampedMessageStreamEvent[] {
  const at = turnCoordinates(projection);
  const isOpen = (requestId: string) => {
    const input = projection.inputs[requestId];
    return input !== undefined && input.status !== "settled";
  };
  const events: UnstampedMessageStreamEvent[] = [];
  for (const challenge of challenges) {
    const expired = audit.candidateHistory.some(
      (candidate) =>
        candidate.candidateId === challenge.candidateId && candidate.status === "timed-out",
    );
    const attempt = projection.authorizations[challenge.attemptId ?? challenge.name];
    if (!expired || attempt?.status !== "required") continue;
    events.push(
      createAuthorizationCompletedEvent({
        ...authorizationEventFields(challenge),
        outcome: "failed",
        reason: "The approval response expired. Please submit a new response.",
        ...at,
      }),
    );
  }
  for (const candidate of audit.activeCandidates) {
    if (projection.candidates[candidate.candidateId] !== undefined) continue;
    if (!isOpen(candidate.requestId)) continue;
    events.push(
      createApprovalCandidateEvent({
        candidateId: candidate.candidateId,
        outcome: "pending",
        requestId: candidate.requestId,
        responderPrincipalId: candidate.responder.principalId,
        ...at,
      }),
    );
  }
  for (const candidate of audit.candidateHistory) {
    if (candidate.status === "allowed" || candidate.status === "authorization-required") continue;
    if (projection.inputs[candidate.requestId] === undefined) continue;
    if (projection.candidates[candidate.candidateId]?.outcome === candidate.status) continue;
    events.push(
      createApprovalCandidateEvent({
        candidateId: candidate.candidateId,
        outcome: candidate.status,
        requestId: candidate.requestId,
        responderPrincipalId: candidate.responder.principalId,
        reason: candidate.reason,
        ...at,
      }),
    );
  }
  for (const settlement of audit.settlements) {
    if (!isOpen(settlement.requestId)) continue;
    events.push(
      createApprovalSettledEvent({
        outcome: settlement.outcome === "allowed" ? "approved" : "cancelled",
        requestId: settlement.requestId,
        responderPrincipalId: settlement.actor.principalId,
        ...at,
      }),
    );
  }
  return events;
}
