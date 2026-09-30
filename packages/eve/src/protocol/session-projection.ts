import type {
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
   * The turn whose work this one continues. A turn that resumes answered approvals, a session-limit
   * prompt, or a completed sign-in continues the turn that asked; any other turn is its own root.
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
   * For a root tool approval, the turn that runs the approved call: the turn open when the approval
   * resolved, or else the next turn to start. Absent for questions, whose turn parks and resumes
   * under its own ID, and for requests a task asked.
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
  readonly result?: "completed" | "failed" | "rejected";
}

/**
 * Where a call stands. `"awaiting-input"` waits on an approval or question; `"rejected"` was
 * denied or not approved; `"interrupted"` was still running when the turn that runs it ended.
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
  readonly id: string;
  readonly name: string;
  readonly attemptId?: string;
  readonly candidateId?: string;
  readonly turnId: string;
  /** The task that needs the sign-in, when a task's run asks. */
  readonly taskId?: string;
  readonly status: "required" | "completed";
  readonly outcome?: AuthorizationOutcome;
  /** A callback, not the running turn, completes the sign-in and resumes the session. */
  readonly awaitsCallback?: true;
}

/**
 * A session's turns, requests, tasks, and sign-ins as its event stream reports them. Clients fold
 * the stream they read, and eve folds a session's own events for its activity, so both apply the
 * same rules.
 *
 * Settlements that resume work precede the turn they resume: an answered approval batch's
 * `input.resolved` and a sign-in callback's `authorization.completed` arrive before that turn's
 * `turn.started`.
 */
export interface SessionProjection {
  readonly activeTurnId?: string;
  readonly turns: Readonly<Record<string, SessionTurn>>;
  readonly inputs: Readonly<Record<string, SessionInput>>;
  readonly tasks: Readonly<Record<string, SessionTask>>;
  readonly calls: Readonly<Record<string, SessionCall>>;
  readonly authorizations: Readonly<Record<string, SessionAuthorization>>;
  /** Work settled while no turn was open, which the next turn to start resumes. */
  readonly resuming?: {
    readonly rootTurnId: string;
    readonly approvalIds: readonly string[];
  };
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
 * turn ends. Asking for a root tool approval ends the turn, so an approved call runs in the turn
 * its approval resumes. A question parks its turn instead, and a request a subagent's task passed
 * up runs while that task works. Any other call still running when its turn ends is interrupted,
 * or cancelled when the turn was.
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
  if (taskCall !== undefined) return taskCall.status === "working" ? "running" : taskCall.status;
  if (call.result !== undefined) return call.result;
  const input = call.requestId === undefined ? undefined : projection.inputs[call.requestId];
  if (input?.status === "open") return "awaiting-input";
  const approval = input?.request.kind === "tool-approval";
  if (input !== undefined && approval && input.outcome === "cancelled") return "cancelled";
  if (input !== undefined && approval && !isApproved(input)) return "rejected";
  if (input?.taskId !== undefined && isTaskWorking(projection, input.taskId)) return "running";
  const runsIn = approval && input.taskId === undefined ? input.resumeTurnId : call.turnId;
  switch (turnLiveness(projection, runsIn)) {
    case "open":
      return options?.streaming === false ? "interrupted" : "running";
    case "cancelled":
      return "cancelled";
    case "closed":
      // A turn that ended on a sign-in parked its unsettled calls behind it.
      return awaitsSignIn(projection, runsIn) ? "awaiting-input" : "interrupted";
  }
}

function awaitsSignIn(projection: SessionProjection, turnId: string | undefined): boolean {
  return Object.values(projection.authorizations).some(
    (attempt) => attempt.status === "required" && attempt.turnId === turnId,
  );
}

/** Whether a call's status can still change. */
export function isCallSettled(status: SessionCallStatus | undefined): boolean {
  return status !== undefined && status !== "running" && status !== "awaiting-input";
}

function isApproved(input: SessionInput): boolean {
  return input.response?.optionId === "approve" || input.outcome === "approved";
}

function isTaskWorking(projection: SessionProjection, taskId: string): boolean {
  const calls = Object.values(projection.tasks[taskId]?.calls ?? {});
  return calls.some((call) => call.status === "working");
}

/** A turn the projection hasn't seen yet can't have ended. */
function turnLiveness(
  projection: SessionProjection,
  turnId: string | undefined,
): "open" | "cancelled" | "closed" {
  const turn = turnId === undefined ? undefined : projection.turns[turnId];
  if (turn === undefined) return "open";
  if (turn.status === "active") return projection.activeTurnId === turnId ? "open" : "closed";
  return turn.status === "cancelled" ? "cancelled" : "closed";
}

/**
 * The attempt an authorization event names: by attempt ID, else by approval candidate, else the
 * latest unfinished attempt for the same connection.
 */
export function authorizationFor(
  projection: SessionProjection,
  data: Pick<AuthorizationCompletedStreamEvent["data"], "attemptId" | "candidateId" | "name">,
): SessionAuthorization | undefined {
  const attempts = Object.values(projection.authorizations);
  if (data.attemptId !== undefined) {
    return attempts.find((attempt) => attempt.attemptId === data.attemptId);
  }
  if (data.candidateId !== undefined) {
    return attempts.find((attempt) => attempt.candidateId === data.candidateId);
  }
  return attempts.findLast(
    (attempt) =>
      attempt.attemptId === undefined &&
      attempt.name === data.name &&
      attempt.status === "required",
  );
}

/** Applies one event. Returns `state` itself when the event changes nothing here. */
export function reduceSessionProjection<S extends SessionProjection>(
  state: S,
  event: UnstampedMessageStreamEvent,
): S {
  switch (event.type) {
    case "turn.started":
      return startTurn(state, event.data.turnId);
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
    // Only a turn's end reaches a session boundary, so no turn stays open across one, and nothing
    // settled before it is waiting to resume.
    case "session.waiting":
    case "session.completed":
    case "session.failed":
      return state.activeTurnId === undefined && state.resuming === undefined
        ? state
        : { ...state, activeTurnId: undefined, resuming: undefined };
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
      let next = state;
      for (const request of event.data.requests) {
        if (next.inputs[request.requestId] !== undefined) continue;
        const input: Mutable<SessionInput> = {
          request,
          status: "open",
          stepIndex: event.data.stepIndex,
          turnId: event.data.turnId,
        };
        if (event.data.taskId !== undefined) input.taskId = event.data.taskId;
        next = recordCall(
          { ...next, inputs: { ...next.inputs, [request.requestId]: input } },
          request.action,
          event.data.turnId,
          request.requestId,
        );
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

function startTurn<S extends SessionProjection>(state: S, turnId: string): S {
  const rootTurnId = state.turns[turnId]?.rootTurnId ?? state.resuming?.rootTurnId ?? turnId;
  let inputs = state.inputs;
  for (const requestId of state.resuming?.approvalIds ?? []) {
    const input = inputs[requestId];
    if (input === undefined || input.resumeTurnId !== undefined) continue;
    inputs = { ...inputs, [requestId]: { ...input, resumeTurnId: turnId } };
  }
  return {
    ...state,
    activeTurnId: turnId,
    inputs,
    resuming: undefined,
    turns: { ...state.turns, [turnId]: { rootTurnId, status: "active", turnId } },
  };
}

/** Records work that resumes in the next turn, which continues the first settled work's root. */
function resume(
  resuming: SessionProjection["resuming"],
  rootTurnId: string,
  approvalId?: string,
): NonNullable<SessionProjection["resuming"]> {
  const approvalIds = resuming?.approvalIds ?? [];
  return {
    approvalIds: approvalId === undefined ? approvalIds : [...approvalIds, approvalId],
    rootTurnId: resuming?.rootTurnId ?? rootTurnId,
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
  let resuming = state.resuming;
  let changed = false;
  for (const resolution of resolutions) {
    const current = inputs[resolution.requestId];
    if (current === undefined) continue;
    let next =
      current.status === "settled"
        ? current
        : {
            ...current,
            outcome: resolution.outcome,
            response: resolution.response ?? current.response,
            status: "settled" as const,
          };
    // A task's request resumes the task's own session, not one of this session's turns.
    if (current.taskId === undefined && current.resumeTurnId === undefined) {
      const approval = current.request.kind === "tool-approval";
      if (state.activeTurnId !== undefined) {
        if (approval) next = { ...next, resumeTurnId: state.activeTurnId };
      } else if (!resuming?.approvalIds.includes(resolution.requestId)) {
        resuming = resume(
          resuming,
          rootTurnOf(state, current.turnId),
          approval ? resolution.requestId : undefined,
        );
      }
    }
    if (next === current) continue;
    inputs[resolution.requestId] = next;
    changed = true;
  }
  if (!changed && resuming === state.resuming) return state;
  return { ...state, inputs, resuming };
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
  const result =
    data.status === "rejected" || data.error?.code === "TOOL_EXECUTION_DENIED"
      ? "rejected"
      : data.status;
  if (call.result === result) return recorded;
  return { ...recorded, calls: { ...recorded.calls, [callId]: { ...call, result } } };
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

/** The ID a sign-in attempt goes by: its attempt ID, else its approval candidate, else its step. */
export function authorizationId(
  data: Pick<
    AuthorizationRequiredStreamEvent["data"],
    "attemptId" | "candidateId" | "name" | "stepIndex" | "turnId"
  >,
): string {
  return (
    data.attemptId ?? data.candidateId ?? `${data.turnId}:${String(data.stepIndex)}:${data.name}`
  );
}

function requireAuthorization<S extends SessionProjection>(
  state: S,
  data: AuthorizationRequiredStreamEvent["data"],
): S {
  const id = authorizationId(data);
  if (state.authorizations[id] !== undefined) return state;
  const attempt: Mutable<SessionAuthorization> = {
    id,
    name: data.name,
    status: "required",
    turnId: data.turnId,
  };
  if (data.attemptId !== undefined) attempt.attemptId = data.attemptId;
  if (data.candidateId !== undefined) attempt.candidateId = data.candidateId;
  if (data.taskId !== undefined) attempt.taskId = data.taskId;
  if (data.webhookUrl !== undefined) attempt.awaitsCallback = true;
  return { ...state, authorizations: { ...state.authorizations, [id]: attempt } };
}

function completeAuthorization<S extends SessionProjection>(
  state: S,
  data: AuthorizationCompletedStreamEvent["data"],
): S {
  const current = authorizationFor(state, data);
  if (current === undefined || current.status === "completed") return state;
  const resumes = current.taskId === undefined && state.activeTurnId === undefined;
  return {
    ...state,
    authorizations: {
      ...state.authorizations,
      [current.id]: { ...current, outcome: data.outcome, status: "completed" },
    },
    resuming: resumes ? resume(state.resuming, rootTurnOf(state, current.turnId)) : state.resuming,
  };
}
