import type { ModelMessage } from "ai";

import { APPROVAL_STATE_KEY, type ApprovalEventCoordinates } from "#harness/approval-candidates.js";
import { PENDING_AUTHORIZATION_KEY } from "#harness/authorization.js";
import { withdrawHeldSignIns } from "#harness/held-requests.js";
import { cancelledStepTranscript } from "#harness/hitl/approval-input-requests.js";
import {
  OPEN_INPUT_REQUESTS_KEY,
  withdrawTurnInputRequests,
} from "#harness/open-input-requests.js";
import { readTurnState, TURN_STATE_KEY, writeTurnStateMap } from "#harness/turn-state.js";
import type { SessionStateMap } from "#harness/types.js";
import { createInputResolvedEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";

/**
 * The session state keys the machine owns. A caller that changes the session
 * between computing a transition and committing it adopts only these, so the
 * machine never overwrites state it does not decide.
 */
const HITL_STATE_KEYS = [
  APPROVAL_STATE_KEY,
  OPEN_INPUT_REQUESTS_KEY,
  PENDING_AUTHORIZATION_KEY,
  TURN_STATE_KEY,
] as const;

const CANCELLED_REASON = "Cancelled.";
const STEERED_REASON = "Cancelled because a new message arrived.";

/**
 * What happened as a result of a transition. The caller applies each one and
 * makes no decision of its own: it publishes an event, appends a message to
 * history, or gives the model a note with the turn's next input.
 */
export type HitlEffect =
  | { readonly kind: "event"; readonly event: UnstampedMessageStreamEvent }
  | { readonly kind: "history"; readonly message: ModelMessage }
  | { readonly kind: "note"; readonly text: string };

export interface HitlTransition {
  readonly effects: readonly HitlEffect[];
  readonly state: SessionStateMap | undefined;
}

/** Something that reached a turn holding open requests. */
export type HitlIntake =
  /** The turn is cancelled: every request it holds ends, answered by nobody. */
  | { readonly kind: "cancel"; readonly at: ApprovalEventCoordinates }
  /**
   * The person who started the turn sent a message instead of answering. Their
   * sign-ins and responders' pending checks end; approvals resolve with the
   * step that reads the message, and the budget question stays open.
   */
  | { readonly kind: "steer"; readonly at: ApprovalEventCoordinates };

export function intake(state: SessionStateMap | undefined, input: HitlIntake): HitlTransition {
  switch (input.kind) {
    case "cancel":
      return cancel(state, input.at);
    case "steer":
      return steer(state, input.at);
    default: {
      const unhandled: never = input;
      throw new TypeError(`Unhandled HITL intake: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Copies the machine's keys from `source` onto `target`, including removals. */
export function adoptHitlState(
  target: SessionStateMap | undefined,
  source: SessionStateMap | undefined,
): SessionStateMap | undefined {
  const next: Record<string, unknown> = { ...target };
  for (const key of HITL_STATE_KEYS) {
    if (source?.[key] === undefined) delete next[key];
    else next[key] = source[key];
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function cancel(state: SessionStateMap | undefined, at: ApprovalEventCoordinates): HitlTransition {
  const signIns = withdrawHeldSignIns(state, { emissionState: at, reason: CANCELLED_REASON });
  const steps = readTurnState(signIns.state).suspended;
  const approvals = steps.flatMap((step) =>
    step.requests.map((request) =>
      createInputResolvedEvent({
        resolutions: [{ kind: request.kind, outcome: "cancelled", requestId: request.requestId }],
        ...step.event,
      }),
    ),
  );
  const requests = withdrawTurnInputRequests({ state: signIns.state });
  const effects: HitlEffect[] = [
    ...signIns.events.map(toEvent),
    ...approvals.map(toEvent),
    ...requests.events.map(toEvent),
  ];
  // Each waiting step's response joins history with every unfinished call answered.
  for (const message of steps.flatMap(cancelledStepTranscript)) {
    effects.push({ kind: "history", message });
  }
  const turn = readTurnState(requests.session.state);
  const next = writeTurnStateMap(requests.session.state, { ...turn, suspended: [] });
  return { effects, state: next };
}

function steer(state: SessionStateMap | undefined, at: ApprovalEventCoordinates): HitlTransition {
  const signIns = withdrawHeldSignIns(state, { emissionState: at, reason: STEERED_REASON });
  const effects: HitlEffect[] = signIns.events.map(toEvent);
  const names = [...new Set(signIns.withdrawn.map((challenge) => challenge.name))];
  if (names.length > 0) {
    effects.push({
      kind: "note",
      text: `Sign-in to ${names.join(", ")} was cancelled because the user sent a new message instead. Ask to sign in again only if the new message still needs it.`,
    });
  }
  return { effects, state: signIns.state };
}

function toEvent(event: UnstampedMessageStreamEvent): HitlEffect {
  return { event, kind: "event" };
}
