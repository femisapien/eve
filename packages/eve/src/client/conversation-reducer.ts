import type {
  AgentObservation,
  ConversationAgentSession,
  ConversationState,
} from "#client/conversation-state.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import type { EveAgentReducer, EveAgentReducerEvent } from "#client/reducer.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { foldSession, initialSessionProjection } from "#protocol/session-projection.js";

/**
 * Transport facts about followed agent sessions. Only the canonical conversation receives them;
 * custom reducers see their results in `conversation.agents`.
 */
export type ClientAgentEvent =
  | {
      readonly data: { readonly sessionId: string };
      readonly type: "client.agent.following" | "client.agent.idle" | "client.agent.unavailable";
    }
  | {
      readonly data: { readonly event: MessageStreamEvent; readonly sessionId: string };
      readonly type: "client.agent.observed";
    };

export type ConversationEvent = EveAgentReducerEvent | ClientAgentEvent;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function initialConversationState(): ConversationState {
  return { ...initialSessionProjection(), messages: [], agents: {} };
}

function updateObservation(
  state: ConversationState,
  sessionId: string,
  update: (observation: AgentObservation) => AgentObservation,
): ConversationState {
  const agent = state.agents[sessionId];
  if (agent === undefined) return state;
  const observation = update(agent.observation);
  if (observation === agent.observation) return state;
  return { ...state, agents: { ...state.agents, [sessionId]: { ...agent, observation } } };
}

function observedConversation(observation: AgentObservation): ConversationState | undefined {
  return observation.status === "not-followed" ? undefined : observation.conversation;
}

/** Applies lifecycle identity and closure to an already projected message state. */
function reduceConversationLifecycle(
  state: ConversationState,
  event: EveAgentReducerEvent,
): ConversationState {
  switch (event.type) {
    case "agent.started": {
      const { callId, name, sessionId, taskId, turnId } = event.data;
      if (state.agents[sessionId] !== undefined) return state;
      const agent: Mutable<ConversationAgentSession> = {
        sessionId,
        name,
        callId,
        turnId,
        observation: { status: "not-followed" },
      };
      if (taskId !== undefined) agent.taskId = taskId;
      return { ...state, agents: { ...state.agents, [sessionId]: agent } };
    }
    // An answer this client sent shows as responded until the stream settles it.
    case "client.input.responded": {
      const inputs = { ...state.inputs };
      for (const response of event.data.responses) {
        const current = inputs[response.requestId];
        if (current?.status !== "open") continue;
        inputs[response.requestId] = { ...current, response, status: "responded" };
      }
      return { ...state, inputs };
    }
    default:
      return foldSession(state, event);
  }
}

const messageReducer = defaultMessageReducer();

/** Pure reduction of accepted root and agent-session observations; followers own transport. */
export function reduceConversation(
  state: ConversationState,
  event: ConversationEvent,
): ConversationState {
  switch (event.type) {
    case "client.agent.following":
      return updateObservation(state, event.data.sessionId, (observation) =>
        observation.status === "following"
          ? observation
          : {
              status: "following",
              conversation: observedConversation(observation) ?? initialConversationState(),
            },
      );
    case "client.agent.observed":
      return updateObservation(state, event.data.sessionId, (observation) =>
        observation.status === "following"
          ? {
              status: "following",
              conversation: reduceConversation(observation.conversation, event.data.event),
            }
          : observation,
      );
    case "client.agent.idle":
      return updateObservation(state, event.data.sessionId, (observation) =>
        observation.status === "following"
          ? { status: "idle", conversation: observation.conversation }
          : observation,
      );
    case "client.agent.unavailable":
      return updateObservation(state, event.data.sessionId, (observation) => {
        const conversation = observedConversation(observation);
        return conversation === undefined
          ? { status: "unavailable" }
          : { status: "unavailable", conversation };
      });
    default: {
      const projected = messageReducer.reduce(state, event);
      return reduceConversationLifecycle({ ...state, ...projected }, event);
    }
  }
}

/** The canonical conversation's reducer, which also folds in followed agent sessions. */
export const canonicalConversationReducer = {
  initial: initialConversationState,
  reduce: reduceConversation,
};

export const conversationReducer: EveAgentReducer<ConversationState> = canonicalConversationReducer;
