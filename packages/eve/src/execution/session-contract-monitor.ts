import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { getPendingAuthorization } from "#harness/authorization.js";
import { getProxyInputRequests } from "#harness/proxy-input-requests.js";
import { allCalls, findCall, readTurnState } from "#harness/turn-state.js";
import { isEveDevEnvironment } from "#internal/application/dev-environment.js";
import { createLogger } from "#internal/logging.js";
import type { SessionStateMap } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { SessionAuthorization, SessionProjection } from "#protocol/session-projection.js";
import {
  checkSessionEvent,
  initialSessionContractState,
  type SessionContractState,
  type SessionContractViolation,
} from "#protocol/session-contract.js";

const log = createLogger("execution.session-contract");

/**
 * Checks sessions against the stream contract. `EVE_SESSION_CONTRACT=warn`
 * logs each violation, the default under `eve dev`; `record` keeps them for
 * {@link takeSessionContractViolations}, as the test setup does; `off` skips
 * the check. Either way the session runs on.
 *
 * Only a session whose stream this process saw from `session.started` is
 * checked, so the check needs one process to host the whole session, as tests
 * and `eve dev` do.
 */
function monitorMode(): "record" | "warn" | undefined {
  const mode = process.env.EVE_SESSION_CONTRACT;
  if (mode === "record" || mode === "warn") return mode;
  return mode === undefined && isEveDevEnvironment() ? "warn" : undefined;
}

/** A development server lives long; it checks only its most recent sessions. */
const MAX_CHECKED_SESSIONS = 100;

/** `null` marks a session first seen mid-stream, which is never checked. */
const sessions = new Map<string, SessionContractState | null>();
const recorded: (SessionContractViolation & { readonly sessionId: string })[] = [];

/** Checks one event a session emitted, in stream order. */
export function observeSessionContract(
  sessionId: string,
  event: UnstampedMessageStreamEvent,
): void {
  if (monitorMode() === undefined) return;
  const state = sessions.get(sessionId);
  if (state === undefined && event.type !== "session.started") {
    track(sessionId, null);
    return;
  }
  if (state === null) return;
  const checked = checkSessionEvent(state ?? initialSessionContractState(), event);
  track(sessionId, checked.state);
  report(sessionId, checked.violations);
}

function track(sessionId: string, state: SessionContractState | null): void {
  sessions.delete(sessionId);
  sessions.set(sessionId, state);
  if (sessions.size > MAX_CHECKED_SESSIONS) sessions.delete(sessions.keys().next().value!);
}

/**
 * Checks, where a step ends, that the session's stream shows the requests and
 * sign-ins the session is waiting on: no more, since a reader would offer a
 * request nobody takes an answer for, and no fewer.
 */
export function observeSessionState(sessionState: DurableSessionState | undefined): void {
  if (monitorMode() === undefined || sessionState === undefined) return;
  let session;
  try {
    session = readDurableSession(sessionState);
  } catch {
    return;
  }
  const projection = sessions.get(session.sessionId)?.projection;
  if (projection === undefined) return;
  report(session.sessionId, checkSessionAgreement(projection, session.state));
}

/**
 * Compares what a session's stream shows open with what its state awaits: the
 * requests it takes answers for and the sign-ins it waits on.
 */
export function checkSessionAgreement(
  projection: SessionProjection,
  state: SessionStateMap | undefined,
): readonly SessionContractViolation[] {
  const turnState = readTurnState(state);
  const awaited = new Set([
    // A decided approval waits on its siblings, not on an answer.
    ...allCalls(turnState).flatMap((call) =>
      call.status === "awaiting-approval" && call.approval?.decision === undefined
        ? [call.approval!.request.requestId]
        : [],
    ),
    ...(turnState.prompt === undefined ? [] : [turnState.prompt.request.requestId]),
    ...getProxyInputRequests(state).keys(),
  ]);
  const shown = new Set(
    Object.entries(projection.inputs).flatMap(([requestId, input]) =>
      input.status === "open" ? [requestId] : [],
    ),
  );
  const signIns = new Set(
    (getPendingAuthorization(state)?.challenges ?? []).map((challenge) => challenge.attemptId),
  );
  // A task's or workflow run's sign-in is the run's to await; the session only relays it.
  const relayed = (attempt: SessionAuthorization) =>
    attempt.taskId !== undefined ||
    (attempt.callIds !== undefined &&
      attempt.callIds.length > 0 &&
      attempt.callIds.every((callId) => findCall(turnState, callId)?.workflow !== undefined));
  const shownSignIns = new Set(
    Object.values(projection.authorizations).flatMap((attempt) =>
      attempt.status === "required" && !relayed(attempt) ? [attempt.attemptId] : [],
    ),
  );
  const violations: SessionContractViolation[] = [];
  const disagree = (message: string) => violations.push({ message, rule: "state-agreement" });
  for (const id of shown) {
    if (!awaited.has(id)) disagree(`${id} is open on the stream, but the session takes no answer.`);
  }
  for (const id of awaited) {
    if (!shown.has(id)) disagree(`The session awaits ${id}, which the stream never asked.`);
  }
  for (const id of shownSignIns) {
    if (!signIns.has(id))
      disagree(`Sign-in ${id} is open on the stream, but the session dropped it.`);
  }
  for (const id of signIns) {
    if (!shownSignIns.has(id)) {
      disagree(`The session awaits sign-in ${id}, which the stream never asked.`);
    }
  }
  return violations;
}

/** Returns and forgets the violations recorded since the last call. */
export function takeSessionContractViolations(): readonly (SessionContractViolation & {
  readonly sessionId: string;
})[] {
  sessions.clear();
  return recorded.splice(0);
}

function report(sessionId: string, violations: readonly SessionContractViolation[]): void {
  if (violations.length === 0) return;
  if (monitorMode() === "warn") {
    for (const violation of violations) {
      log.warn(`session stream contract: ${violation.message}`, {
        rule: violation.rule,
        sessionId,
      });
    }
    return;
  }
  recorded.push(...violations.map((violation) => ({ ...violation, sessionId })));
}
