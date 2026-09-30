import type {
  ActionResultStatus,
  AuthorizationCompletedStreamEvent,
  AuthorizationOutcome,
  AuthorizationRequiredStreamEvent,
  UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { RuntimeActionRequest, RuntimeActionResult } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonValue } from "#shared/json.js";

export interface SessionTurn {
  readonly turnId: string;
  readonly status: "active" | "completed" | "cancelled" | "failed";
  /** The open turn is parked, holding on its tasks or on a question one of its calls asked. */
  readonly waiting?: boolean;
  /**
   * The first turn of the work this one continues: `turn.started` names the turn whose answered
   * approvals, session-limit prompt, or completed sign-in it resumes, and that turn's root is this
   * one's. Any other turn is its own root.
   */
  readonly rootTurnId: string;
}

export interface SessionInput {
  readonly request: InputRequest;
  readonly turnId: string;
  readonly stepIndex: number;
  /** The task whose run asks, when a task asks. */
  readonly taskId?: string;
  /** `"responded"` is a client's own answer that the stream has not settled yet. */
  readonly status: "open" | "responded" | "settled";
  readonly response?: InputResponse;
  readonly outcome?: string;
  /**
   * This session's call that waits on the request: the call an approval asks about, or for a
   * request a task's run asks, the call that run serves.
   */
  readonly callId?: string;
  /**
   * For an approved tool approval this session asked, the turn that runs the approved call, as the
   * approval's `input.resolved` names it.
   */
  readonly resumeTurnId?: string;
}

/** One call that started or reached a task, settled by its `task.settled`. */
export interface SessionTaskCall {
  readonly callId: string;
  readonly turnId: string;
  readonly status: "working" | "completed" | "failed" | "cancelled";
  /** The call's result; present only when `status` is `"completed"`. */
  readonly output?: JsonValue;
  /** Why the call failed; present only when `status` is `"failed"`. */
  readonly error?: { readonly message: string };
}

export interface SessionTask {
  readonly taskId: string;
  /** The tool whose call started the task. */
  readonly name: string;
  /**
   * `"agent"` when a subagent's tool, local or remote, started the task; `"tool"` for an authored
   * tool, including one that opens sessions with `ctx.agent`.
   */
  readonly kind: "agent" | "tool";
  /** Calls in the order they started or reached the task. */
  readonly calls: Readonly<Record<string, SessionTaskCall>>;
}

/** One call the model made, as the stream reports it; {@link callStatus} says where it stands. */
export interface SessionCall {
  readonly callId: string;
  readonly turnId: string;
  readonly kind: RuntimeActionRequest["kind"];
  /** The tool a `tool-call` runs. */
  readonly toolName?: string;
  /** The latest approval or question asked about the call. */
  readonly requestId?: string;
  /** The task the call started or reached; its `task.settled`, not `action.result`, settles it. */
  readonly taskId?: string;
  /** How the call's final `action.result` settled it. */
  readonly result?: ActionResultStatus;
}

/**
 * Where a call stands. `"awaiting-input"` waits on an approval or question; `"rejected"` was
 * denied or not approved; `"cancelled"` was stopped by eve, such as a call that asked for a
 * sign-in or one a cancelled turn cut off; `"interrupted"` was still running when the turn that
 * runs it ended, or when the stream stopped.
 */
export type SessionCallStatus =
  | "running"
  | "awaiting-input"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled"
  | "interrupted";

/** One sign-in attempt, from its `authorization.required` to its `authorization.completed`. */
export interface SessionAuthorization {
  readonly attemptId: string;
  readonly name: string;
  readonly candidateId?: string;
  /** This session's calls that asked for the sign-in. */
  readonly callIds?: readonly string[];
  readonly turnId: string;
  /** The task that needs the sign-in, when a task's run asks. */
  readonly taskId?: string;
  readonly status: "required" | "completed";
  readonly outcome?: AuthorizationOutcome;
  /** A callback, not the running turn, completes the sign-in and resumes the session. */
  readonly awaitsCallback?: true;
}

/**
 * A session's turns, requests, tasks, calls, and sign-ins as its event stream reports them.
 * Clients fold the stream they read, and eve folds a session's own events for its activity, so
 * both apply the same rules. Every relation here is one an event states: which turn a turn
 * continues, which turn runs an approved call, which call a request or sign-in belongs to, and
 * how a call ended. The fold infers only what no event can say: that a call still running when its
 * turn ended, or when the stream stopped, was interrupted.
 */
export interface SessionProjection {
  readonly activeTurnId?: string;
  readonly turns: Readonly<Record<string, SessionTurn>>;
  readonly inputs: Readonly<Record<string, SessionInput>>;
  readonly tasks: Readonly<Record<string, SessionTask>>;
  readonly calls: Readonly<Record<string, SessionCall>>;
  /** Sign-in attempts by attempt ID. */
  readonly authorizations: Readonly<Record<string, SessionAuthorization>>;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function initialSessionProjection(): SessionProjection {
  return { authorizations: {}, calls: {}, inputs: {}, tasks: {}, turns: {} };
}

/** The turn whose work `turnId` continues; see {@link SessionTurn.rootTurnId}. */
export function rootTurnOf(projection: SessionProjection, turnId: string): string {
  return projection.turns[turnId]?.rootTurnId ?? turnId;
}

/**
 * Where a call stands. A call that started a task runs until its task settles, even after its
 * turn ends, and waits on input while a request its task's run asked is open. An approved call
 * runs in the turn its approval's `input.resolved` names. A question parks its turn instead, which
 * resumes under the same ID. Any other call still running when its turn ends is interrupted, or
 * cancelled when the turn was.
 *
 * `streaming: false` says nothing more will arrive, so a call whose turn never ended is
 * interrupted too.
 */
export function callStatus(
  projection: SessionProjection,
  callId: string,
  options?: { readonly streaming?: boolean },
): SessionCallStatus | undefined {
  const call = projection.calls[callId];
  if (call === undefined) return undefined;
  const taskCall =
    call.taskId === undefined ? undefined : projection.tasks[call.taskId]?.calls[callId];
  if (taskCall !== undefined) {
    if (taskCall.status !== "working") return taskCall.status;
    return hasOpenRequest(projection, callId) ? "awaiting-input" : "running";
  }
  if (call.result !== undefined) return call.result;
  const input = call.requestId === undefined ? undefined : projection.inputs[call.requestId];
  if (input?.status === "open") return "awaiting-input";
  let runsIn = call.turnId;
  if (input?.request.kind === "tool-approval") {
    if (input.outcome === "cancelled") return "cancelled";
    if (!isApproved(input)) return "rejected";
    // Approved, but the rest of its batch is still unanswered.
    if (input.resumeTurnId === undefined) return "awaiting-input";
    runsIn = input.resumeTurnId;
  }
  switch (turnLiveness(projection, runsIn)) {
    case "open":
      return options?.streaming === false ? "interrupted" : "running";
    case "cancelled":
      return "cancelled";
    case "closed":
      return "interrupted";
  }
}

/** Whether a call's status can still change. */
export function isCallSettled(status: SessionCallStatus | undefined): boolean {
  return status !== undefined && status !== "running" && status !== "awaiting-input";
}

function isApproved(input: SessionInput): boolean {
  return input.response?.optionId === "approve" || input.outcome === "approved";
}

function hasOpenRequest(projection: SessionProjection, callId: string): boolean {
  return Object.values(projection.inputs).some(
    (input) => input.callId === callId && input.status !== "settled",
  );
}

/** A turn the projection hasn't seen yet can't have ended. */
function turnLiveness(
  projection: SessionProjection,
  turnId: string,
): "open" | "cancelled" | "closed" {
  const turn = projection.turns[turnId];
  if (turn === undefined) return "open";
  if (turn.status === "active") return projection.activeTurnId === turnId ? "open" : "closed";
  return turn.status === "cancelled" ? "cancelled" : "closed";
}

/** Applies one event. Returns `state` itself when the event changes nothing here. */
export function reduceSessionProjection<S extends SessionProjection>(
  state: S,
  event: UnstampedMessageStreamEvent,
): S {
  switch (event.type) {
    case "turn.started":
      return startTurn(state, event.data);
    case "turn.waiting":
      return updateTurn(state, event.data.turnId, (turn) =>
        turn.status === "active" && turn.waiting !== true ? { ...turn, waiting: true } : turn,
      );
    case "step.started":
      return updateTurn(state, event.data.turnId, (turn) =>
        turn.waiting === true
          ? { rootTurnId: turn.rootTurnId, status: turn.status, turnId: turn.turnId }
          : turn,
      );
    case "turn.completed":
    case "turn.cancelled":
    case "turn.failed": {
      const { turnId } = event.data;
      const status =
        event.type === "turn.completed"
          ? "completed"
          : event.type === "turn.failed"
            ? "failed"
            : "cancelled";
      return {
        ...state,
        activeTurnId: state.activeTurnId === turnId ? undefined : state.activeTurnId,
        turns: {
          ...state.turns,
          [turnId]: { rootTurnId: rootTurnOf(state, turnId), status, turnId },
        },
      };
    }
    // Only a turn's end reaches a session boundary, so no turn stays open across one.
    case "session.waiting":
    case "session.completed":
    case "session.failed":
      return state.activeTurnId === undefined ? state : { ...state, activeTurnId: undefined };
    case "actions.requested": {
      let next = state;
      for (const action of event.data.actions) {
        next = recordCall(next, action, event.data.turnId);
      }
      return next;
    }
    case "action.result":
      return settleCall(state, event.data);
    case "task.started": {
      const { callId, kind, name, taskId, turnId } = event.data;
      const task = state.tasks[taskId] ?? { calls: {}, kind, name, taskId };
      if (task.calls[callId] !== undefined) return state;
      const call = state.calls[callId];
      return {
        ...state,
        calls: call === undefined ? state.calls : { ...state.calls, [callId]: { ...call, taskId } },
        tasks: {
          ...state.tasks,
          [taskId]: {
            ...task,
            calls: { ...task.calls, [callId]: { callId, status: "working", turnId } },
          },
        },
      };
    }
    case "task.settled":
      return settleTaskCall(state, event.data);
    case "input.requested": {
      const { callId, stepIndex, taskId, turnId } = event.data;
      let next = state;
      for (const request of event.data.requests) {
        if (next.inputs[request.requestId] !== undefined) continue;
        const input: Mutable<SessionInput> = {
          callId: callId ?? request.action.callId,
          request,
          status: "open",
          stepIndex,
          turnId,
        };
        if (taskId !== undefined) input.taskId = taskId;
        next = { ...next, inputs: { ...next.inputs, [request.requestId]: input } };
        // A task's run asks on behalf of the call it serves; a passed up approval's action is
        // another session's call, which this session never made.
        if (callId === undefined)
          next = recordCall(next, request.action, turnId, request.requestId);
      }
      return next;
    }
    case "approval.candidate": {
      const current = state.inputs[event.data.requestId];
      if (current === undefined || current.status === "settled") return state;
      if (event.data.outcome === "pending") return state;
      return {
        ...state,
        inputs: {
          ...state.inputs,
          [event.data.requestId]: { ...current, response: undefined, status: "open" },
        },
      };
    }
    // One approval of a batch can settle before its siblings are answered; only the batch's
    // `input.resolved` resumes work.
    case "approval.settled": {
      const current = state.inputs[event.data.requestId];
      if (current === undefined || current.status === "settled") return state;
      return {
        ...state,
        inputs: {
          ...state.inputs,
          [event.data.requestId]: { ...current, outcome: event.data.outcome, status: "settled" },
        },
      };
    }
    case "input.resolved":
      return resolveInputs(state, event.data.resolutions);
    case "authorization.required":
      return requireAuthorization(state, event.data);
    case "authorization.completed":
      return completeAuthorization(state, event.data);
    default:
      return state;
  }
}

function updateTurn<S extends SessionProjection>(
  state: S,
  turnId: string,
  update: (turn: SessionTurn) => SessionTurn,
): S {
  const turn = state.turns[turnId];
  if (turn === undefined) return state;
  const next = update(turn);
  return next === turn ? state : { ...state, turns: { ...state.turns, [turnId]: next } };
}

function startTurn<S extends SessionProjection>(
  state: S,
  data: Extract<UnstampedMessageStreamEvent, { readonly type: "turn.started" }>["data"],
): S {
  const { continuesTurnId, turnId } = data;
  const rootTurnId =
    state.turns[turnId]?.rootTurnId ??
    (continuesTurnId === undefined ? turnId : rootTurnOf(state, continuesTurnId));
  return {
    ...state,
    activeTurnId: turnId,
    turns: { ...state.turns, [turnId]: { rootTurnId, status: "active", turnId } },
  };
}

function resolveInputs<S extends SessionProjection>(
  state: S,
  resolutions: Extract<
    UnstampedMessageStreamEvent,
    { readonly type: "input.resolved" }
  >["data"]["resolutions"],
): S {
  const inputs = { ...state.inputs };
  let changed = false;
  for (const resolution of resolutions) {
    const current = inputs[resolution.requestId];
    if (current === undefined) continue;
    const next: Mutable<SessionInput> = { ...current };
    // A policy can settle one approval of a batch first; the batch still names the turn it resumes.
    if (current.status !== "settled") {
      next.outcome = resolution.outcome;
      next.status = "settled";
      if (resolution.response !== undefined) next.response = resolution.response;
    }
    if (resolution.resumeTurnId !== undefined && current.resumeTurnId === undefined) {
      next.resumeTurnId = resolution.resumeTurnId;
    }
    if (next.status === current.status && next.resumeTurnId === current.resumeTurnId) continue;
    inputs[resolution.requestId] = next;
    changed = true;
  }
  return changed ? { ...state, inputs } : state;
}

function recordCall<S extends SessionProjection>(
  state: S,
  action: {
    readonly callId: string;
    readonly kind: SessionCall["kind"];
    readonly toolName?: string;
  },
  turnId: string,
  requestId?: string,
): S {
  const { callId, kind } = action;
  const current = state.calls[callId];
  if (current !== undefined && (requestId === undefined || current.requestId === requestId)) {
    return state;
  }
  const call: Mutable<SessionCall> = current ? { ...current } : { callId, kind, turnId };
  if (current === undefined && kind === "tool-call" && action.toolName !== undefined) {
    call.toolName = action.toolName;
  }
  if (requestId !== undefined) call.requestId = requestId;
  return { ...state, calls: { ...state.calls, [callId]: call } };
}

const RESULT_KINDS = {
  "load-skill-result": "load-skill",
  "subagent-result": "subagent-call",
  "tool-result": "tool-call",
} as const satisfies Record<RuntimeActionResult["kind"], SessionCall["kind"]>;

function settleCall<S extends SessionProjection>(
  state: S,
  data: Extract<UnstampedMessageStreamEvent, { readonly type: "action.result" }>["data"],
): S {
  const { callId } = data.result;
  const recorded = recordCall(
    state,
    {
      callId,
      kind: RESULT_KINDS[data.result.kind],
      toolName: data.result.kind === "tool-result" ? data.result.toolName : undefined,
    },
    data.turnId,
  );
  const call = recorded.calls[callId]!;
  if (call.result === data.status) return recorded;
  return { ...recorded, calls: { ...recorded.calls, [callId]: { ...call, result: data.status } } };
}

function settleTaskCall<S extends SessionProjection>(
  state: S,
  data: Extract<UnstampedMessageStreamEvent, { readonly type: "task.settled" }>["data"],
): S {
  const task = state.tasks[data.taskId];
  const call = task?.calls[data.callId];
  if (task === undefined || call === undefined || call.status !== "working") return state;
  const settled: Mutable<SessionTaskCall> = {
    callId: data.callId,
    status: data.status,
    turnId: call.turnId,
  };
  if (data.status === "completed" && data.output !== undefined) settled.output = data.output;
  if (data.status === "failed" && data.error !== undefined) settled.error = data.error;
  return {
    ...state,
    tasks: {
      ...state.tasks,
      [data.taskId]: { ...task, calls: { ...task.calls, [data.callId]: settled } },
    },
  };
}

function requireAuthorization<S extends SessionProjection>(
  state: S,
  data: AuthorizationRequiredStreamEvent["data"],
): S {
  const { attemptId } = data;
  if (state.authorizations[attemptId] !== undefined) return state;
  const attempt: Mutable<SessionAuthorization> = {
    attemptId,
    name: data.name,
    status: "required",
    turnId: data.turnId,
  };
  if (data.candidateId !== undefined) attempt.candidateId = data.candidateId;
  if (data.callIds !== undefined) attempt.callIds = data.callIds;
  if (data.taskId !== undefined) attempt.taskId = data.taskId;
  if (data.webhookUrl !== undefined) attempt.awaitsCallback = true;
  return { ...state, authorizations: { ...state.authorizations, [attemptId]: attempt } };
}

function completeAuthorization<S extends SessionProjection>(
  state: S,
  data: AuthorizationCompletedStreamEvent["data"],
): S {
  const current = state.authorizations[data.attemptId];
  if (current === undefined || current.status === "completed") return state;
  return {
    ...state,
    authorizations: {
      ...state.authorizations,
      [data.attemptId]: { ...current, outcome: data.outcome, status: "completed" },
    },
  };
}
