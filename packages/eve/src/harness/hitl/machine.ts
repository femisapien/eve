import type { ModelMessage } from "ai";

import type { ApprovalEventCoordinates } from "#harness/approval-candidates.js";
import { PENDING_AUTHORIZATION_KEY } from "#harness/authorization.js";
import { withdrawHeldSignIns } from "#harness/held-requests.js";
import { cancelledApprovalResults } from "#harness/hitl/approval-input-requests.js";
import {
  OPEN_INPUT_REQUESTS_KEY,
  readRelayedInputRequests,
  readTurnInputRequests,
  withdrawTurnInputRequests,
  type RelayedInputQuestion,
  type RelayedInputRequest,
} from "#harness/open-input-requests.js";
import type { SessionStateMap } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";

/**
 * The session state keys the machine owns. A caller that changes the session
 * between computing a transition and committing it adopts only these, so the
 * machine never overwrites state it does not decide.
 */
const HITL_STATE_KEYS = [OPEN_INPUT_REQUESTS_KEY, PENDING_AUTHORIZATION_KEY] as const;

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

/** The open requests a typed reply may answer, all at once. */
export type TextAnswerable =
  | { readonly kind: "approvals"; readonly requests: readonly InputRequest[] }
  | { readonly kind: "session-limit"; readonly request: InputRequest }
  | {
      readonly kind: "relayed";
      readonly question: RelayedInputQuestion;
      readonly requestId: string;
    };

/**
 * Which open requests a typed reply answers. It answers only when everything
 * open is one group, so it never settles a request the person did not mean:
 * the approvals one model step raised (none needing a responder's sign-in),
 * the budget question alone, or one relayed question whose options are known.
 * Otherwise the message is an ordinary message, and steers the turn.
 */
export function textAnswerable(
  state: SessionStateMap | undefined,
  input: {
    /** Leaves out relayed requests an earlier answer in the same delivery settled. */
    readonly routable?: (requestId: string, route: RelayedInputRequest) => boolean;
  } = {},
): TextAnswerable | undefined {
  const turn = [...readTurnInputRequests(state).values()];
  const relayed = [...readRelayedInputRequests(state)].filter(
    ([requestId, route]) => input.routable?.(requestId, route) !== false,
  );
  if (relayed.length === 0) {
    const [only] = turn;
    if (only === undefined) return undefined;
    if (turn.length === 1 && only.request.kind === "session-limit") {
      return { kind: "session-limit", request: only.request };
    }
    const approvals = turn.every(
      (entry) => entry.request.kind === "tool-approval" && entry.responseAuthRequired !== true,
    );
    return approvals
      ? { kind: "approvals", requests: turn.map((entry) => entry.request) }
      : undefined;
  }
  const [first] = relayed;
  if (turn.length > 0 || relayed.length !== 1 || first === undefined) return undefined;
  const [requestId, route] = first;
  const question =
    route.kind === "question" ? (route.workflowAsk?.question ?? route.question) : undefined;
  return question === undefined ? undefined : { kind: "relayed", question, requestId };
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
  // Read before the requests retire: each waiting call needs its not-run result.
  const notRun = cancelledApprovalResults(signIns.state);
  const requests = withdrawTurnInputRequests({ state: signIns.state });
  const effects: HitlEffect[] = [...signIns.events.map(toEvent), ...requests.events.map(toEvent)];
  if (notRun !== undefined) effects.push({ kind: "history", message: notRun });
  return { effects, state: requests.session.state };
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
