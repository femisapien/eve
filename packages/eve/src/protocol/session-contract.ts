import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  callStatus,
  initialSessionProjection,
  reduceSessionProjection,
  type SessionProjection,
} from "#protocol/session-projection.js";

/**
 * A rule every session stream keeps, so that any reader folding it reaches the
 * state the session is in:
 *
 * - `own-coordinates`: an event names only turns this stream started, and only
 *   calls it announced: a turn's `continuesTurnId`, a request's `callId`, and
 *   a sign-in's `callIds`.
 * - `turn-order`: one turn runs at a time, its content arrives inside it, and
 *   nothing follows the session's end. An approved tool approval this session
 *   asked names in `resumeTurnId` the open turn, or else the next turn to start.
 * - `open-after-owner`: no request or sign-in stays open after what owns it
 *   can no longer take the answer: its task, its cancelled turn, the cleared
 *   context, or the ended session.
 * - `unsettled-call`: a turn that completes leaves no call it ran without an
 *   outcome.
 * - `resolved-twice`: a request resolves once.
 * - `unasked-sign-in`: a call that settles as needing a sign-in is named by an
 *   `authorization.required` before its turn ends.
 * - `state-agreement`: where a step ends, the stream shows exactly the
 *   requests and sign-ins the session awaits. Only a check that can read the
 *   session's state applies it.
 */
export type SessionContractRule =
  | "own-coordinates"
  | "open-after-owner"
  | "resolved-twice"
  | "state-agreement"
  | "turn-order"
  | "unasked-sign-in"
  | "unsettled-call";

export interface SessionContractViolation {
  readonly rule: SessionContractRule;
  /** The type of the event that broke the rule, or that ended what it broke. */
  readonly eventType?: UnstampedMessageStreamEvent["type"];
  readonly message: string;
}

/** What {@link checkSessionEvent} carries from one event to the next. */
export interface SessionContractState {
  readonly projection: SessionProjection;
  readonly startedTurnIds: ReadonlySet<string>;
  readonly resolvedRequestIds: ReadonlySet<string>;
  /** The turn an approval resolved between turns named to run its call. */
  readonly resumeTurnId?: string;
  /** Calls that settled as needing a sign-in the stream has not asked for yet. */
  readonly signInCalls: ReadonlySet<string>;
  readonly ended: boolean;
}

export function initialSessionContractState(): SessionContractState {
  return {
    ended: false,
    projection: initialSessionProjection(),
    resolvedRequestIds: new Set(),
    signInCalls: new Set(),
    startedTurnIds: new Set(),
  };
}

/** Checks one event against the rules, given the stream before it. */
export function checkSessionEvent(
  state: SessionContractState,
  event: UnstampedMessageStreamEvent,
): {
  readonly state: SessionContractState;
  readonly violations: readonly SessionContractViolation[];
} {
  const violations: SessionContractViolation[] = [];
  const violate = (rule: SessionContractRule, message: string) =>
    violations.push({ eventType: event.type, message, rule });
  const previous = state.projection;

  if (state.ended) violate("turn-order", `${event.type} follows the session's end.`);
  const turnId = eventTurnId(event);
  let { resumeTurnId } = state;
  if (event.type === "turn.started") {
    if (previous.activeTurnId !== undefined) {
      violate("turn-order", `${turnId} starts while ${previous.activeTurnId} is open.`);
    }
    const { continuesTurnId } = event.data;
    if (continuesTurnId !== undefined && !state.startedTurnIds.has(continuesTurnId)) {
      violate("own-coordinates", `${turnId} continues ${continuesTurnId}, which never started.`);
    }
    if (resumeTurnId !== undefined && resumeTurnId !== turnId) {
      violate("turn-order", `${turnId} starts where an approved call named ${resumeTurnId}.`);
    }
    resumeTurnId = undefined;
  } else if (turnId !== undefined && !state.startedTurnIds.has(turnId)) {
    violate("own-coordinates", `${event.type} names ${turnId}, which this stream never started.`);
  } else if (
    turnId !== undefined &&
    TURN_CONTENT.has(event.type) &&
    turnId !== previous.activeTurnId
  ) {
    violate("turn-order", `${event.type} for ${turnId} arrives outside that turn.`);
  }
  let { resolvedRequestIds } = state;
  if (event.type === "input.resolved") {
    for (const resolution of event.data.resolutions) {
      if (resolvedRequestIds.has(resolution.requestId)) {
        violate("resolved-twice", `${resolution.requestId} resolves again.`);
      }
      const named = resolution.resumeTurnId;
      const asked = previous.inputs[resolution.requestId];
      if (
        named === undefined &&
        resolution.outcome === "approved" &&
        asked?.request.kind === "tool-approval" &&
        asked.taskId === undefined
      ) {
        violate(
          "turn-order",
          `${resolution.requestId} is approved without naming its call's turn.`,
        );
      }
      if (named === undefined) continue;
      if (
        previous.activeTurnId === undefined
          ? state.startedTurnIds.has(named)
          : named !== previous.activeTurnId
      ) {
        violate("turn-order", `${resolution.requestId} names ${named} to run its approved call.`);
      }
      if (previous.activeTurnId === undefined) resumeTurnId = named;
    }
    resolvedRequestIds = new Set([
      ...resolvedRequestIds,
      ...event.data.resolutions.map(({ requestId }) => requestId),
    ]);
  }

  for (const callId of namedCalls(event)) {
    if (previous.calls[callId] === undefined) {
      violate(
        "own-coordinates",
        `${event.type} names ${callId}, which this stream never announced.`,
      );
    }
  }

  let { signInCalls } = state;
  if (
    event.type === "action.result" &&
    event.data.status === "cancelled" &&
    event.data.error?.code === "AUTHORIZATION_REQUIRED"
  ) {
    signInCalls = new Set([...signInCalls, event.data.result.callId]);
  } else if (event.type === "authorization.required" && event.data.callIds !== undefined) {
    const named = new Set(event.data.callIds);
    signInCalls = new Set([...signInCalls].filter((callId) => !named.has(callId)));
  } else if (
    (event.type === "turn.completed" ||
      event.type === "turn.cancelled" ||
      event.type === "turn.failed") &&
    signInCalls.size > 0
  ) {
    for (const callId of signInCalls) {
      violate("unasked-sign-in", `${callId} settles for a sign-in that ${turnId} never asks for.`);
    }
    signInCalls = new Set();
  }

  const projection = reduceSessionProjection(previous, event);
  switch (event.type) {
    case "turn.completed":
      for (const call of Object.values(projection.calls)) {
        if (
          callStatus(projection, call.callId) === "interrupted" &&
          callStatus(previous, call.callId) !== "interrupted"
        ) {
          violate("unsettled-call", `${turnId} completes with ${call.callId} still unsettled.`);
        }
      }
      break;
    case "turn.cancelled":
      for (const [requestId, input] of openInputs(projection)) {
        if (input.taskId !== undefined || input.turnId === turnId) {
          violate("open-after-owner", `${requestId} stays open after ${turnId} is cancelled.`);
        }
      }
      break;
    case "context.cleared":
      for (const [requestId, input] of openInputs(projection)) {
        if (input.taskId === undefined) {
          violate("open-after-owner", `${requestId} stays open after the context is cleared.`);
        }
      }
      for (const attempt of Object.values(projection.authorizations)) {
        if (attempt.status === "required" && attempt.taskId === undefined) {
          violate(
            "open-after-owner",
            `Sign-in ${attempt.attemptId} stays open after the context is cleared.`,
          );
        }
      }
      break;
    case "session.waiting":
      if (resumeTurnId !== undefined) {
        violate("turn-order", `The session waits before ${resumeTurnId} runs its approved call.`);
      }
      for (const [requestId, input] of openInputs(projection)) {
        const task = input.taskId === undefined ? undefined : projection.tasks[input.taskId];
        if (
          task !== undefined &&
          !Object.values(task.calls).some((call) => call.status === "working")
        ) {
          violate("open-after-owner", `${requestId} stays open after task ${task.taskId} settles.`);
        }
      }
      break;
    case "session.completed":
    case "session.failed":
      for (const [requestId] of openInputs(projection)) {
        violate("open-after-owner", `${requestId} stays open after the session ends.`);
      }
      break;
  }

  const startedTurnIds =
    event.type === "turn.started"
      ? new Set([...state.startedTurnIds, event.data.turnId])
      : state.startedTurnIds;
  return {
    state: {
      ended: state.ended || event.type === "session.completed" || event.type === "session.failed",
      projection,
      resolvedRequestIds,
      resumeTurnId,
      signInCalls,
      startedTurnIds,
    },
    violations,
  };
}

/** Checks a whole stream, from its first event, against the rules. */
export function checkSessionStream(
  events: readonly UnstampedMessageStreamEvent[],
): readonly SessionContractViolation[] {
  let state = initialSessionContractState();
  const violations: SessionContractViolation[] = [];
  for (const event of events) {
    const checked = checkSessionEvent(state, event);
    state = checked.state;
    violations.push(...checked.violations);
  }
  return violations;
}

/** Events that only an open turn produces, so they must name it. */
const TURN_CONTENT: ReadonlySet<UnstampedMessageStreamEvent["type"]> = new Set([
  "action.input.appended",
  "actions.requested",
  "message.appended",
  "message.completed",
  "message.received",
  "reasoning.appended",
  "reasoning.completed",
  "step.completed",
  "step.failed",
  "step.started",
  "turn.cancelled",
  "turn.completed",
  "turn.failed",
  "turn.waiting",
]);

/** Session-wide events carry the next turn's coordinates between turns, so they name no turn. */
const SESSION_WIDE: ReadonlySet<UnstampedMessageStreamEvent["type"]> = new Set([
  "compaction.completed",
  "compaction.requested",
  "context.cleared",
]);

function eventTurnId(event: UnstampedMessageStreamEvent): string | undefined {
  if (SESSION_WIDE.has(event.type) || !("data" in event)) return undefined;
  const data: object = event.data;
  const turnId = "turnId" in data ? data.turnId : undefined;
  return typeof turnId === "string" ? turnId : undefined;
}

/** Calls of this session an event says its request or sign-in belongs to. */
function namedCalls(event: UnstampedMessageStreamEvent): readonly string[] {
  if (event.type === "input.requested") {
    return event.data.callId === undefined ? [] : [event.data.callId];
  }
  return event.type === "authorization.required" ? (event.data.callIds ?? []) : [];
}

function openInputs(projection: SessionProjection) {
  return Object.entries(projection.inputs).filter(([, input]) => input.status === "open");
}
