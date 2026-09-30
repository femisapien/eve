import type { EveAuthorizationPart, EveMessageData } from "#client/message-reducer-types.js";
import {
  initialSessionProjection,
  type SessionAuthorization,
  type SessionProjection,
} from "#protocol/session-projection.js";
import type { AuthorizationOutcome } from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonValue } from "#shared/json.js";

export interface ConversationTurn {
  readonly turnId: string;
  readonly status: "active" | "completed" | "cancelled" | "failed";
  /** The open turn is parked, holding on its tasks or on a question one of its calls asked. */
  readonly waiting?: boolean;
}

export interface ConversationInput {
  readonly request: InputRequest;
  readonly turnId: string;
  readonly stepIndex: number;
  /** The task whose run asks, when a task asks. */
  readonly taskId?: string;
  /** `"responded"` is this client's own answer, which the stream has not settled yet. */
  readonly status: "open" | "responded" | "settled";
  readonly response?: InputResponse;
  readonly outcome?: string;
  /**
   * This session's call that waits on the request: the call an approval asks about, or for a
   * request a task's run asks, the call that run serves. A subagent's approval passed up through
   * its task names the task's call here, while its `request.action` names the subagent's own call.
   */
  readonly callId?: string;
  /**
   * For an approved tool approval this session asked, the turn that runs the approved call, as the
   * approval's `input.resolved` names it.
   */
  readonly resumeTurnId?: string;
}

/** One call that started or reached a task, settled by its `task.settled`. */
export interface ConversationTaskCall {
  readonly callId: string;
  readonly turnId: string;
  readonly status: "working" | "completed" | "failed" | "cancelled";
  /** The call's result; present only when `status` is `"completed"`. */
  readonly output?: JsonValue;
  /** Why the call failed; present only when `status` is `"failed"`. */
  readonly error?: { readonly message: string };
}

export interface ConversationTask {
  readonly taskId: string;
  /** The tool whose call started the task. */
  readonly name: string;
  /**
   * `"agent"` when a subagent's tool, local or remote, started the task; `"tool"` for an authored
   * tool, including one that opens sessions with `ctx.agent`.
   */
  readonly kind: "agent" | "tool";
  /** Calls in the order they started or reached the task. */
  readonly calls: Readonly<Record<string, ConversationTaskCall>>;
}

export type AgentObservation =
  | { readonly status: "not-followed" }
  | { readonly status: "following"; readonly conversation: ConversationState }
  /** Every call so far has shown its content; a later call to the task resumes following. */
  | { readonly status: "idle"; readonly conversation: ConversationState }
  | {
      /** The stream failed; this does not mean the agent failed. */
      readonly status: "unavailable";
      readonly conversation?: ConversationState;
    };

/** A session a run opened with `ctx.agent`, as its `agent.started` announced it. */
export interface ConversationAgentSession {
  readonly sessionId: string;
  readonly name: string;
  /** The call whose invocation opened the session. */
  readonly callId: string;
  readonly turnId: string;
  /** The task whose run opened the session; absent when an `execute` call opened it. */
  readonly taskId?: string;
  readonly observation: AgentObservation;
}

/** Renderable conversation state. Root and agent-session input IDs occupy separate scopes. */
export interface ConversationState extends EveMessageData {
  readonly activeTurnId?: string;
  readonly turns: Readonly<Record<string, ConversationTurn>>;
  readonly inputs: Readonly<Record<string, ConversationInput>>;
  readonly tasks: Readonly<Record<string, ConversationTask>>;
  /** Sessions opened by this session's runs, by session ID. */
  readonly agents: Readonly<Record<string, ConversationAgentSession>>;
}

/**
 * The conversation with the lifecycle eve folds for it: every call's standing and every sign-in
 * attempt, which the public type leaves out so eve can change how it keeps them. The canonical
 * reducer builds this shape; code inside eve reads it through {@link sessionProjectionOf}.
 */
export type ConversationProjection = ConversationState & SessionProjection;

/** An empty conversation, with the lifecycle eve folds for it. */
export function initialConversation(): ConversationProjection {
  return { ...initialSessionProjection(), agents: {}, messages: [] };
}

function isProjected(state: ConversationState): state is ConversationProjection {
  return "calls" in state && "authorizations" in state;
}

/**
 * The session projection behind a conversation. A conversation assembled by hand, without the
 * canonical reducer, has no call or sign-in lifecycle yet.
 */
export function sessionProjectionOf(state: ConversationState): ConversationProjection {
  if (isProjected(state)) return state;
  const turns = Object.fromEntries(
    Object.entries(state.turns).map(([turnId, turn]) => [turnId, { ...turn, rootTurnId: turnId }]),
  );
  return { ...state, authorizations: {}, calls: {}, turns };
}

/** Inputs awaiting an answer, including requests introduced in earlier turns. */
export function openConversationInputs(state: ConversationState): readonly ConversationInput[] {
  return Object.values(state.inputs).filter((input) => input.status === "open");
}

/** Authorization attempts remain visible across turns, including parked callbacks. */
export function conversationAuthorizations(
  state: ConversationState,
): readonly EveAuthorizationPart[] {
  return state.messages.flatMap((message) =>
    message.role === "assistant"
      ? message.parts.filter((part): part is EveAuthorizationPart => part.type === "authorization")
      : [],
  );
}

/** Sign-ins the session still waits on, each resuming its work when its callback arrives. */
export function pendingSignIns(state: ConversationState): readonly SessionAuthorization[] {
  return Object.values(sessionProjectionOf(state).authorizations).filter(
    (attempt) => attempt.status === "required" && attempt.awaitsCallback === true,
  );
}

/** A sign-in the session still waits on, which resumes its work when the callback arrives. */
export function hasPendingAuthorizations(state: ConversationState): boolean {
  return pendingSignIns(state).length > 0;
}

/** Where one sign-in attempt stands. */
export interface ConversationSignIn {
  readonly status: "required" | "completed";
  /** How the attempt ended; present once `status` is `"completed"`. */
  readonly outcome?: AuthorizationOutcome;
}

/**
 * Where a sign-in part's attempt stands, from the session's lifecycle rather than the part, which
 * carries only what to show.
 */
export function signInState(
  state: ConversationState,
  part: EveAuthorizationPart,
): ConversationSignIn {
  const attempt = sessionProjectionOf(state).authorizations[part.attemptId];
  if (attempt !== undefined) {
    return attempt.outcome === undefined
      ? { status: attempt.status }
      : { outcome: attempt.outcome, status: attempt.status };
  }
  return part.state === "completed"
    ? { outcome: part.outcome, status: "completed" }
    : { status: "required" };
}

/**
 * The agent task whose calls a session receives, when the session is that agent's own. eve's agent
 * tools send each call as one message, in call order, which is what lets a client attribute the
 * session's turns to calls. A session an authored tool opens with `ctx.agent` has no such task.
 */
export function agentToolTask(
  state: ConversationState,
  agent: ConversationAgentSession,
): ConversationTask | undefined {
  const task = agent.taskId === undefined ? undefined : state.tasks[agent.taskId];
  return task?.kind === "agent" ? task : undefined;
}

/** The session an agent tool forwards its task's calls to. */
export function agentToolSession(
  state: ConversationState,
  task: ConversationTask,
): ConversationAgentSession | undefined {
  return Object.values(state.agents).find(
    (agent) => agentToolTask(state, agent)?.taskId === task.taskId,
  );
}

/**
 * Whether a followed agent tool session has shown everything its task's calls produced so far:
 * no call is working, the session has no open turn, question, or sign-in, and every completed call's
 * message has arrived. The last check covers a child stream that lags the root stream.
 */
export function isAgentSessionCaughtUp(
  state: ConversationState,
  agent: ConversationAgentSession,
): boolean {
  if (agent.observation.status !== "following" && agent.observation.status !== "idle") {
    return false;
  }
  const task = agentToolTask(state, agent);
  if (task === undefined) return false;
  const calls = Object.values(task.calls);
  if (calls.some((call) => call.status === "working")) return false;
  const child = agent.observation.conversation;
  if (child.activeTurnId !== undefined) return false;
  if (Object.values(child.inputs).some((input) => input.status !== "settled")) return false;
  if (hasPendingAuthorizations(child)) return false;
  const received = child.messages.filter((message) => message.role === "user").length;
  return received >= calls.filter((call) => call.status === "completed").length;
}

/**
 * Attributes an agent tool session's turns to the calls that produced them. The k-th message the
 * session received came from the task's k-th call; a turn without a message of its own, such as
 * one resumed after an approval, continues the previous call. A call whose message joined a
 * running turn owns no turn.
 */
export function agentCallTurns(
  task: ConversationTask,
  conversation: ConversationState,
): ReadonlyMap<string, readonly string[]> {
  const callIds = Object.keys(task.calls);
  const owners = new Map<string, string>();
  let index = 0;
  for (const message of conversation.messages) {
    if (message.role !== "user") continue;
    const callId = callIds[index++];
    const turnId = message.metadata?.turnId;
    if (callId !== undefined && turnId !== undefined && !owners.has(turnId)) {
      owners.set(turnId, callId);
    }
  }
  const turns = new Map<string, string[]>(callIds.map((callId) => [callId, []]));
  let owner: string | undefined;
  for (const turnId of Object.keys(conversation.turns)) {
    owner = owners.get(turnId) ?? owner;
    if (owner !== undefined) turns.get(owner)?.push(turnId);
  }
  return turns;
}

/**
 * Whether a call's content may still arrive on its agent tool session: one of the call's turns is
 * still open there, or the call completed before its message reached the session.
 */
export function isAgentCallContentPending(
  task: ConversationTask,
  call: ConversationTaskCall,
  conversation: ConversationState,
): boolean {
  const turnIds = agentCallTurns(task, conversation).get(call.callId) ?? [];
  const { activeTurnId } = conversation;
  if (activeTurnId !== undefined && turnIds.includes(activeTurnId)) return true;
  if (call.status !== "completed") return false;
  const received = conversation.messages.filter((message) => message.role === "user").length;
  return received <= Object.keys(task.calls).indexOf(call.callId);
}

/**
 * Tool calls a followed agent session already shows. eve also projects them into the parent
 * session, so a view that renders the agent's own conversation skips them at the parent.
 */
export function followedAgentToolCallIds(state: ConversationState): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const agent of Object.values(state.agents)) {
    if (agent.observation.status === "not-followed") continue;
    for (const message of agent.observation.conversation?.messages ?? []) {
      for (const part of message.parts) {
        if (part.type === "dynamic-tool") ids.add(part.toolCallId);
      }
    }
  }
  return ids;
}
