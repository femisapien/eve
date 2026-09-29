import {
  agentCallTurns,
  agentToolSession,
  type ConversationAgentSession,
  type ConversationInput,
  type ConversationState,
  type ConversationTask,
  type ConversationTaskCall,
  conversationAuthorizations,
  type EveAuthorizationPart,
  type EveMessage,
  type EveMessagePart,
  followedAgentToolCallIds,
  type ToolCallState,
  type ToolCallStatus,
  toolCallState,
} from "eve/react";

// Turns a conversation into what the chat renders. Styling lives in the components; this file
// only decides what each row is and what state it's in.

export interface ViewContext {
  readonly conversation: ConversationState;
  /** Whether the session's stream is still delivering, which a running call waits on. */
  readonly busy: boolean;
  /** Calls that started a subagent, by call ID. */
  readonly agentCalls: ReadonlyMap<string, AgentCall>;
  /** Tool calls a followed subagent already shows, which eve also projects into this session. */
  readonly childToolIds: ReadonlySet<string>;
}

export interface AgentCall {
  readonly task: ConversationTask;
  readonly call: ConversationTaskCall;
  readonly agent: ConversationAgentSession;
}

export function viewContext(conversation: ConversationState, busy: boolean): ViewContext {
  const agentCalls = new Map<string, AgentCall>();
  for (const task of Object.values(conversation.tasks)) {
    const agent = agentToolSession(conversation, task);
    if (agent === undefined) continue;
    for (const call of Object.values(task.calls))
      agentCalls.set(call.callId, { agent, call, task });
  }
  return {
    agentCalls,
    busy,
    childToolIds: followedAgentToolCallIds(conversation),
    conversation,
  };
}

// ---------------------------------------------------------------------------
// Message blocks: prose, and the work between it
// ---------------------------------------------------------------------------

export type ActivityItem =
  | { readonly kind: "reasoning"; readonly key: string; readonly text: string }
  | { readonly kind: "text"; readonly key: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly name: string;
      readonly input: unknown;
      readonly state: ToolCallState;
      /** Set when the call started a subagent, whose work nests under the row. */
      readonly agent?: AgentCall;
    }
  | {
      readonly kind: "auth";
      readonly key: string;
      readonly part: EveAuthorizationPart;
      readonly state: ToolCallState;
    };

export type MessageBlock =
  | { readonly kind: "text"; readonly key: string; readonly text: string; streaming: boolean }
  | { readonly kind: "activity"; readonly key: string; readonly items: ActivityItem[] };

/** Splits an assistant message into its prose and one activity block for each run of work. */
export function messageBlocks(message: EveMessage, context: ViewContext): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  const turnId = message.metadata?.turnId;
  for (const [index, part] of message.parts.entries()) {
    if (part.type === "text") {
      if (part.text.trim().length === 0) continue;
      const key = `text:${part.id ?? index}`;
      blocks.push({ key, kind: "text", streaming: part.state === "streaming", text: part.text });
      continue;
    }
    const item = activityItem(part, index, turnId, context);
    if (item === undefined) continue;
    const last = blocks.at(-1);
    if (last?.kind === "activity") last.items.push(item);
    else blocks.push({ items: [item], key: `activity:${item.key}`, kind: "activity" });
  }
  return blocks;
}

/** A subagent's work for one call, prose included, with the same rules as the root. */
export function agentActivity(call: AgentCall): ActivityItem[] | undefined {
  const observation = call.agent.observation;
  const child = observation?.status === "not-followed" ? undefined : observation?.conversation;
  if (child === undefined) return undefined;
  const turnIds = new Set(agentCallTurns(call.task, child).get(call.call.callId) ?? []);
  const context = viewContext(child, call.call.status === "working");
  return child.messages.flatMap((message) => {
    const turnId = message.metadata?.turnId;
    if (message.role !== "assistant" || turnId === undefined || !turnIds.has(turnId)) return [];
    return message.parts.flatMap((part, index) => {
      if (part.type !== "text") return activityItem(part, index, turnId, context) ?? [];
      const text = part.text.trim();
      return text.length === 0 ? [] : [{ key: `text:${part.id ?? index}`, kind: "text", text }];
    });
  });
}

function activityItem(
  part: EveMessagePart,
  index: number,
  turnId: string | undefined,
  context: ViewContext,
): ActivityItem | undefined {
  switch (part.type) {
    case "reasoning": {
      const text = part.text.trim();
      return text.length === 0
        ? undefined
        : { key: `reasoning:${part.id ?? index}`, kind: "reasoning", text };
    }
    case "authorization":
      return {
        key: `auth:${part.attemptId ?? `${part.turnId}:${part.stepIndex}:${part.name}`}`,
        kind: "auth",
        part,
        state: authorizationState(part),
      };
    case "dynamic-tool": {
      const callId = part.toolCallId;
      const request = part.toolMetadata?.eve?.inputRequest;
      if (request?.kind === "session-limit" || context.childToolIds.has(callId)) return undefined;
      // A request a subagent passed up shows under that subagent's row, and in the dock.
      if (
        request !== undefined &&
        context.conversation.inputs[request.requestId]?.taskId !== undefined
      ) {
        return undefined;
      }
      return {
        agent: context.agentCalls.get(callId),
        input: part.input,
        key: `tool:${callId}`,
        kind: "tool",
        name: part.toolMetadata?.eve?.name ?? part.toolName,
        state: toolCallState(context.conversation, part, { streaming: context.busy, turnId }),
      };
    }
    default:
      return undefined;
  }
}

function authorizationState(part: EveAuthorizationPart): ToolCallState {
  if (part.state === "required") return { status: "awaiting-input" };
  switch (part.outcome) {
    case "authorized":
      return { status: "done" };
    case "declined":
      return { errorText: part.reason, status: "denied" };
    default:
      return { errorText: part.reason ?? part.outcome, status: "failed" };
  }
}

export function itemStatus(item: ActivityItem): ToolCallStatus {
  return item.kind === "tool" || item.kind === "auth" ? item.state.status : "done";
}

// ---------------------------------------------------------------------------
// Everything waiting on the person
// ---------------------------------------------------------------------------

export type DockItem =
  | {
      readonly kind: "input";
      readonly key: string;
      readonly input: ConversationInput;
      /** The subagent or task that passed the request up, when this session didn't ask. */
      readonly from?: string;
    }
  | { readonly kind: "auth"; readonly key: string; readonly part: EveAuthorizationPart };

export function dockItems(conversation: ConversationState): DockItem[] {
  const items: DockItem[] = [];
  for (const input of Object.values(conversation.inputs)) {
    if (input.status !== "open") continue;
    const task = input.taskId === undefined ? undefined : conversation.tasks[input.taskId];
    const from =
      task === undefined ? undefined : (agentToolSession(conversation, task)?.name ?? task.name);
    items.push({ from, input, key: `input:${input.request.requestId}`, kind: "input" });
  }
  for (const part of conversationAuthorizations(conversation)) {
    if (part.state !== "required") continue;
    items.push({
      key: `auth:${part.attemptId ?? `${part.turnId}:${part.stepIndex}:${part.name}`}`,
      kind: "auth",
      part,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** A short, single-line description of a call's input. */
export function describeInput(input: unknown): string | undefined {
  if (typeof input === "string") return oneLine(input);
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${oneLine(String(value))}`);
    }
    if (parts.length === 3) break;
  }
  return parts.length === 0 ? undefined : parts.join(", ");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
