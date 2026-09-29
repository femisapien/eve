import type { MessageStreamEvent } from "eve/client";
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
  type EveDynamicToolPart,
  type EveMessage,
  type EveMessagePart,
  followedAgentToolCallIds,
  type ToolCallState,
  toolCallState,
} from "eve/react";

// How the chat lays out a conversation. Each call's state comes from eve's `toolCallState`, which
// the `eve dev` TUI shares.

/** One status vocabulary for every row, at every depth. */
export type ActivityStatus =
  | "working"
  | "needs-you"
  | "done"
  | "failed"
  | "cancelled"
  | "denied"
  | "interrupted";

export interface CallState {
  readonly status: ActivityStatus;
  readonly output?: unknown;
  readonly errorText?: string;
}

// ---------------------------------------------------------------------------
// Facts only the root event stream carries
// ---------------------------------------------------------------------------

/** A point inside a turn where the transcript breaks: a wait, or a message sent into the turn. */
export interface TurnBreak {
  readonly kind: "wait" | "message";
  /** Parts from later steps render after the break. */
  readonly afterStep: number;
  readonly at?: string;
  readonly resumedAt?: string;
  readonly messageId?: string;
}

export interface CallTimes {
  readonly startedAt?: string;
  readonly settledAt?: string;
}

export interface StreamFacts {
  /** Authored `label.start` text, by call ID. */
  readonly labels: ReadonlyMap<string, string>;
  readonly callTimes: ReadonlyMap<string, CallTimes>;
  /** Calls whose `task.started` said they call an agent. */
  readonly agentCallIds: ReadonlySet<string>;
  readonly turnBreaks: ReadonlyMap<string, readonly TurnBreak[]>;
  readonly turnFailures: ReadonlyMap<string, { readonly code: string; readonly message: string }>;
  /** User messages that arrived inside a running turn, rendered at their break. */
  readonly steeredMessageIds: ReadonlySet<string>;
  readonly sessionFailure?: { readonly code: string; readonly message: string };
}

export const EMPTY_FACTS: StreamFacts = {
  agentCallIds: new Set(),
  callTimes: new Map(),
  labels: new Map(),
  steeredMessageIds: new Set(),
  turnBreaks: new Map(),
  turnFailures: new Map(),
};

export function streamFacts(events: readonly MessageStreamEvent[]): StreamFacts {
  const labels = new Map<string, string>();
  const callTimes = new Map<string, { startedAt?: string; settledAt?: string }>();
  const taskCallIds = new Set<string>();
  const agentCallIds = new Set<string>();
  const turnBreaks = new Map<string, TurnBreak[]>();
  const turnFailures = new Map<string, { code: string; message: string }>();
  const steeredMessageIds = new Set<string>();
  const lastStep = new Map<string, number>();
  let sessionFailure: { code: string; message: string } | undefined;

  const times = (callId: string) => {
    let entry = callTimes.get(callId);
    if (entry === undefined) {
      entry = {};
      callTimes.set(callId, entry);
    }
    return entry;
  };
  const breaksOf = (turnId: string) => {
    let entry = turnBreaks.get(turnId);
    if (entry === undefined) {
      entry = [];
      turnBreaks.set(turnId, entry);
    }
    return entry;
  };

  for (const event of events) {
    const at = event.meta?.at;
    switch (event.type) {
      case "actions.requested":
        for (const action of event.data.actions) times(action.callId).startedAt ??= at;
        for (const [callId, presentation] of Object.entries(event.data.presentation ?? {})) {
          if (presentation.label) labels.set(callId, presentation.label);
        }
        break;
      case "action.result": {
        const callId = event.data.result.callId;
        // A task call's receipt isn't its end; its `task.settled` is.
        if (!taskCallIds.has(callId)) times(callId).settledAt = at;
        for (const [id, presentation] of Object.entries(event.data.presentation ?? {})) {
          if (presentation.label && !labels.has(id)) labels.set(id, presentation.label);
        }
        break;
      }
      case "task.started": {
        taskCallIds.add(event.data.callId);
        if (event.data.kind === "agent") agentCallIds.add(event.data.callId);
        const entry = times(event.data.callId);
        entry.startedAt ??= at;
        delete entry.settledAt;
        break;
      }
      case "task.settled":
        times(event.data.callId).settledAt = at;
        break;
      case "step.started": {
        lastStep.set(event.data.turnId, event.data.stepIndex);
        const breaks = turnBreaks.get(event.data.turnId);
        const last = breaks?.at(-1);
        if (breaks !== undefined && last?.kind === "wait" && last.resumedAt === undefined) {
          breaks[breaks.length - 1] = { ...last, resumedAt: at };
        }
        break;
      }
      case "turn.waiting": {
        const breaks = breaksOf(event.data.turnId);
        const last = breaks.at(-1);
        const afterStep = lastStep.get(event.data.turnId) ?? -1;
        // A turn can park more than once without resuming, as each new question re-parks it.
        if (last?.kind === "wait" && last.resumedAt === undefined && last.afterStep === afterStep) {
          break;
        }
        breaks.push({ afterStep, at, kind: "wait" });
        break;
      }
      case "message.received": {
        const afterStep = lastStep.get(event.data.turnId);
        if (afterStep === undefined) break;
        const messageId = `${event.meta?.id ?? `${event.data.turnId}:${event.data.sequence}`}:user`;
        breaksOf(event.data.turnId).push({ afterStep, at, kind: "message", messageId });
        steeredMessageIds.add(messageId);
        break;
      }
      case "turn.failed":
        turnFailures.set(event.data.turnId, {
          code: event.data.code,
          message: friendlyFailure(event.data.code, event.data.message),
        });
        break;
      case "session.failed":
        sessionFailure = {
          code: event.data.code,
          message: friendlyFailure(event.data.code, event.data.message),
        };
        break;
    }
  }

  return {
    agentCallIds,
    callTimes,
    labels,
    sessionFailure,
    steeredMessageIds,
    turnBreaks,
    turnFailures,
  };
}

function friendlyFailure(code: string, message: string): string {
  return code === "MODEL_CALL_FAILED"
    ? "The model is temporarily unavailable. Please try again."
    : message;
}

// ---------------------------------------------------------------------------
// Projection context
// ---------------------------------------------------------------------------

export interface AgentCall {
  readonly task: ConversationTask;
  readonly call: ConversationTaskCall;
  readonly agent?: ConversationAgentSession;
  readonly name: string;
  /** Tells apart calls to the same agent, in call order, when there are several. */
  readonly ordinal?: number;
}

export interface TaskCallRef {
  readonly task: ConversationTask;
  readonly call: ConversationTaskCall;
}

export interface ViewContext {
  readonly conversation: ConversationState;
  readonly facts: StreamFacts;
  readonly agentCalls: ReadonlyMap<string, AgentCall>;
  readonly taskCalls: ReadonlyMap<string, TaskCallRef>;
  /** Tool calls a followed child already shows, which eve also projects into this session. */
  readonly childToolIds: ReadonlySet<string>;
  /** Inputs each task call asked, including requests its agents passed up. */
  readonly callInputs: ReadonlyMap<string, readonly ConversationInput[]>;
  /** Whether the session's stream is still delivering, which a call waits on to finish. */
  readonly busy: boolean;
}

export function viewContext(
  conversation: ConversationState,
  facts: StreamFacts,
  busy: boolean,
): ViewContext {
  const taskCalls = new Map<string, TaskCallRef>();
  for (const task of Object.values(conversation.tasks)) {
    for (const call of Object.values(task.calls)) taskCalls.set(call.callId, { call, task });
  }
  return {
    agentCalls: agentCalls(conversation, facts),
    busy,
    callInputs: callInputs(conversation),
    childToolIds: followedAgentToolCallIds(conversation),
    conversation,
    facts,
    taskCalls,
  };
}

function agentCalls(conversation: ConversationState, facts: StreamFacts): Map<string, AgentCall> {
  const entries: Array<Omit<AgentCall, "ordinal">> = [];
  for (const task of Object.values(conversation.tasks)) {
    const agent = agentToolSession(conversation, task);
    const calls = Object.values(task.calls);
    if (agent === undefined && !calls.some((call) => facts.agentCallIds.has(call.callId))) continue;
    for (const call of calls) entries.push({ agent, call, name: agent?.name ?? task.name, task });
  }
  const order = new Map<string, number>();
  for (const message of conversation.messages) {
    for (const part of message.parts) {
      if (part.type === "dynamic-tool") order.set(part.toolCallId, order.size);
    }
  }
  entries.sort(
    (left, right) =>
      (order.get(left.call.callId) ?? order.size) - (order.get(right.call.callId) ?? order.size),
  );
  const totals = new Map<string, number>();
  for (const { name } of entries) totals.set(name, (totals.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const calls = new Map<string, AgentCall>();
  for (const entry of entries) {
    const ordinal = (seen.get(entry.name) ?? 0) + 1;
    seen.set(entry.name, ordinal);
    calls.set(
      entry.call.callId,
      (totals.get(entry.name) ?? 0) > 1 ? { ...entry, ordinal } : { ...entry },
    );
  }
  return calls;
}

/** Attributes each task's inputs to the latest of its calls in the input's turn. */
function callInputs(conversation: ConversationState): Map<string, ConversationInput[]> {
  const byCall = new Map<string, ConversationInput[]>();
  for (const input of Object.values(conversation.inputs)) {
    if (input.taskId === undefined) continue;
    const task = conversation.tasks[input.taskId];
    if (task === undefined) continue;
    const calls = Object.values(task.calls);
    const call = calls.findLast((candidate) => candidate.turnId === input.turnId) ?? calls.at(-1);
    if (call === undefined) continue;
    const list = byCall.get(call.callId) ?? [];
    list.push(input);
    byCall.set(call.callId, list);
  }
  return byCall;
}

// ---------------------------------------------------------------------------
// Activity items
// ---------------------------------------------------------------------------

export type ActivityItem =
  | {
      readonly kind: "reasoning";
      readonly key: string;
      readonly text: string;
      readonly streaming: boolean;
    }
  | {
      readonly kind: "text";
      readonly key: string;
      readonly text: string;
      readonly streaming: boolean;
    }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly name: string;
      readonly label?: string;
      readonly input: unknown;
      readonly state: CallState;
      readonly request?: ConversationInput;
      readonly times?: CallTimes;
    }
  | {
      readonly kind: "agent";
      readonly key: string;
      readonly name: string;
      readonly input: unknown;
      readonly state: CallState;
      readonly call: AgentCall;
      readonly inputs: readonly ConversationInput[];
      readonly times?: CallTimes;
    }
  | {
      readonly kind: "task";
      readonly key: string;
      readonly name: string;
      readonly label?: string;
      readonly input: unknown;
      readonly state: CallState;
      readonly taskId: string;
      readonly inputs: readonly ConversationInput[];
      readonly times?: CallTimes;
    }
  | {
      readonly kind: "auth";
      readonly key: string;
      readonly part: EveAuthorizationPart;
      readonly state: CallState;
    };

export function activityItems(
  parts: readonly EveMessagePart[],
  turnId: string | undefined,
  context: ViewContext,
  options: { readonly includeText: boolean },
): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const [index, part] of parts.entries()) {
    switch (part.type) {
      case "text":
        if (options.includeText && part.text.trim().length > 0) {
          items.push({
            key: `text:${part.id ?? index}`,
            kind: "text",
            streaming: part.state === "streaming",
            text: part.text,
          });
        }
        break;
      case "reasoning":
        if (part.text.trim().length > 0) {
          items.push({
            key: `reasoning:${part.id ?? index}`,
            kind: "reasoning",
            streaming: part.state === "streaming",
            text: part.text,
          });
        }
        break;
      case "authorization":
        items.push({
          key: `auth:${part.attemptId ?? `${part.turnId}:${part.stepIndex}:${part.name}`}`,
          kind: "auth",
          part,
          state: authorizationState(part),
        });
        break;
      case "dynamic-tool": {
        const item = toolItem(part, turnId, context);
        if (item !== undefined) items.push(item);
        break;
      }
    }
  }
  return items;
}

function toolItem(
  part: EveDynamicToolPart,
  turnId: string | undefined,
  context: ViewContext,
): ActivityItem | undefined {
  const callId = part.toolCallId;
  const inputRequest = part.toolMetadata?.eve?.inputRequest;
  if (inputRequest?.kind === "session-limit") return undefined;
  if (context.childToolIds.has(callId)) return undefined;
  const taskCall = context.taskCalls.get(callId);
  // A request a task's agent passed up belongs to that task's row, not this session's.
  if (
    inputRequest !== undefined &&
    taskCall === undefined &&
    context.conversation.inputs[inputRequest.requestId]?.taskId !== undefined
  ) {
    return undefined;
  }
  const times = context.facts.callTimes.get(callId);
  const state = (inputs: readonly ConversationInput[] = []) =>
    callState(
      toolCallState(context.conversation, part, { streaming: context.busy, turnId }),
      inputs,
    );
  const agentCall = context.agentCalls.get(callId);
  if (agentCall !== undefined) {
    const inputs = context.callInputs.get(callId) ?? [];
    return {
      call: agentCall,
      input: part.input,
      inputs,
      key: `agent:${callId}`,
      kind: "agent",
      name: agentCall.name,
      state: state(inputs),
      times,
    };
  }
  if (taskCall !== undefined) {
    const inputs = context.callInputs.get(callId) ?? [];
    return {
      input: part.input,
      inputs,
      key: `task:${callId}`,
      kind: "task",
      label: context.facts.labels.get(callId),
      name: taskCall.task.name,
      state: state(inputs),
      taskId: taskCall.task.taskId,
      times,
    };
  }
  const request =
    inputRequest === undefined ? undefined : context.conversation.inputs[inputRequest.requestId];
  return {
    input: part.input,
    key: `tool:${callId}`,
    kind: "tool",
    label: context.facts.labels.get(callId),
    name: part.toolMetadata?.eve?.name ?? part.toolName,
    request,
    state: state(),
    times,
  };
}

/** A working task that asked something, directly or through its agents, needs the person. */
function callState(state: ToolCallState, inputs: readonly ConversationInput[]): CallState {
  switch (state.status) {
    case "running":
      return {
        ...state,
        status: inputs.some((input) => input.status === "open") ? "needs-you" : "working",
      };
    case "awaiting-input":
      return { ...state, status: "needs-you" };
    default:
      return { ...state, status: state.status };
  }
}

function authorizationState(part: EveAuthorizationPart): CallState {
  if (part.state === "required") return { status: "needs-you" };
  switch (part.outcome) {
    case "authorized":
      return { status: "done" };
    case "declined":
      return { errorText: part.reason, status: "denied" };
    default:
      return { errorText: part.reason ?? part.outcome, status: "failed" };
  }
}

export function agentCallName(call: AgentCall): string {
  return `subagent:${call.name}${call.ordinal === undefined ? "" : `#${call.ordinal}`}`;
}

/** The literal identifier a row shows: `called <tool>`, `subagent:<name>`, `task:<name>`. */
export function itemName(item: ActivityItem): string {
  switch (item.kind) {
    case "reasoning":
      return "reasoning";
    case "text":
      return "reply";
    case "tool":
      return item.name;
    case "agent":
      return agentCallName(item.call);
    case "task":
      return `task:${item.name}`;
    case "auth":
      return `sign-in:${item.part.name}`;
  }
}

export function itemStatus(item: ActivityItem): ActivityStatus {
  switch (item.kind) {
    case "reasoning":
    case "text":
      return item.streaming ? "working" : "done";
    default:
      return item.state.status;
  }
}

// ---------------------------------------------------------------------------
// Subagent threads
// ---------------------------------------------------------------------------

export type AgentThread =
  | { readonly kind: "followed"; readonly context: ViewContext; readonly messages: EveMessage[] }
  | { readonly kind: "not-followed" }
  | { readonly kind: "unavailable" };

/** The share of an agent's session one call produced, projected with the same rules. */
export function agentThread(call: AgentCall): AgentThread {
  const observation = call.agent?.observation;
  if (observation === undefined || observation.status === "not-followed") {
    return { kind: "not-followed" };
  }
  const child = observation.conversation;
  if (child === undefined) return { kind: "unavailable" };
  const turnIds = new Set(agentCallTurns(call.task, child).get(call.call.callId) ?? []);
  const messages = child.messages.filter(
    (message) =>
      message.role === "assistant" &&
      message.metadata?.turnId !== undefined &&
      turnIds.has(message.metadata.turnId),
  );
  const busy = call.call.status === "working";
  return { context: viewContext(child, EMPTY_FACTS, busy), kind: "followed", messages };
}

// ---------------------------------------------------------------------------
// Turn layout
// ---------------------------------------------------------------------------

export interface TurnSegment {
  readonly key: string;
  readonly texts: readonly {
    readonly key: string;
    readonly text: string;
    readonly streaming: boolean;
  }[];
  readonly activity: readonly ActivityItem[];
}

export type TurnEntry =
  | { readonly kind: "segment"; readonly segment: TurnSegment }
  | { readonly kind: "break"; readonly key: string; readonly brk: TurnBreak };

/**
 * Splits an assistant message at the turn's breaks. Each segment shows its prose first, then one
 * activity row for the work that led to it.
 */
export function turnLayout(message: EveMessage, context: ViewContext): TurnEntry[] {
  const turnId = message.metadata?.turnId;
  const breaks = (turnId === undefined ? undefined : context.facts.turnBreaks.get(turnId)) ?? [];
  const phases: EveMessagePart[][] = breaks.map(() => []);
  phases.push([]);
  let current = 0;
  for (const part of message.parts) {
    if (part.type === "step-start") continue;
    const stepIndex = "stepIndex" in part ? part.stepIndex : undefined;
    if (stepIndex !== undefined) {
      current = breaks.filter((brk) => brk.afterStep < stepIndex).length;
    }
    phases[current]?.push(part);
  }

  const entries: TurnEntry[] = [];
  for (const [index, parts] of phases.entries()) {
    const texts = parts.flatMap((part, partIndex) =>
      part.type === "text" && part.text.trim().length > 0
        ? [
            {
              key: `text:${part.id ?? `${index}:${partIndex}`}`,
              streaming: part.state === "streaming",
              text: part.text,
            },
          ]
        : [],
    );
    const activity = activityItems(parts, turnId, context, { includeText: false });
    if (texts.length > 0 || activity.length > 0) {
      entries.push({
        kind: "segment",
        segment: { activity, key: `${message.id}:${index}`, texts },
      });
    }
    const brk = breaks[index];
    if (brk === undefined) continue;
    // A wait that hasn't resumed is the footer's "Waiting on …" line, not a divider, and a
    // momentary one isn't worth a line.
    if (brk.kind === "wait" && (brk.resumedAt === undefined || waitedMs(brk) < MIN_WAIT_MS)) {
      continue;
    }
    const previous = entries.at(-1);
    if (brk.kind === "wait" && previous?.kind === "break" && previous.brk.kind === "wait") continue;
    entries.push({ brk, key: `${message.id}:break:${index}`, kind: "break" });
  }
  return entries;
}

const MIN_WAIT_MS = 2_000;

function waitedMs(brk: TurnBreak): number {
  const waited = Date.parse(brk.resumedAt ?? "") - Date.parse(brk.at ?? "");
  return Number.isNaN(waited) ? Number.POSITIVE_INFINITY : waited;
}

// ---------------------------------------------------------------------------
// Turn footer
// ---------------------------------------------------------------------------

export type TurnFooter =
  | { readonly kind: "working" }
  | {
      readonly kind: "waiting";
      /** The person first when the turn itself asked, then each working call by name. */
      readonly on: readonly { readonly name: string; readonly needsYou: boolean }[];
      readonly since?: string;
    }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly message: string };

export function turnFooter(
  turnId: string | undefined,
  context: ViewContext,
): TurnFooter | undefined {
  const turn = turnId === undefined ? undefined : context.conversation.turns[turnId];
  if (turn === undefined) return context.busy ? { kind: "working" } : undefined;
  switch (turn.status) {
    case "active": {
      if (turn.waiting !== true) return { kind: "working" };
      const on = new Map<string, boolean>();
      const open = Object.values(context.conversation.inputs).filter(
        (input) => input.status === "open",
      );
      if (open.some((input) => input.turnId === turn.turnId && input.taskId === undefined)) {
        on.set("you", true);
      }
      for (const task of Object.values(context.conversation.tasks)) {
        for (const call of Object.values(task.calls)) {
          if (call.status !== "working") continue;
          const agentCall = context.agentCalls.get(call.callId);
          const name = agentCall === undefined ? `task:${task.name}` : agentCallName(agentCall);
          const asks = open.some((input) => input.taskId === task.taskId);
          on.set(name, (on.get(name) ?? false) || asks);
        }
      }
      const since = context.facts.turnBreaks
        .get(turn.turnId)
        ?.findLast((brk) => brk.kind === "wait" && brk.resumedAt === undefined)?.at;
      return {
        kind: "waiting",
        on: [...on].map(([name, needsYou]) => ({ name, needsYou })),
        since,
      };
    }
    case "cancelled":
      return { kind: "cancelled" };
    case "failed":
      return {
        kind: "failed",
        message: context.facts.turnFailures.get(turn.turnId)?.message ?? "The turn failed.",
      };
    case "completed":
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Inputs dock
// ---------------------------------------------------------------------------

export type DockItem =
  | {
      readonly kind: "input";
      readonly key: string;
      readonly input: ConversationInput;
      /** Who asked, outermost first: `subagent:researcher`, `subagent:analyst`. */
      readonly requester: readonly string[];
    }
  | { readonly kind: "auth"; readonly key: string; readonly part: EveAuthorizationPart };

export function dockItems(context: ViewContext): DockItem[] {
  const items: DockItem[] = [];
  for (const input of Object.values(context.conversation.inputs)) {
    if (input.status !== "open") continue;
    items.push({
      input,
      key: `input:${input.request.requestId}`,
      kind: "input",
      requester: requesterPath(context, input),
    });
  }
  for (const part of conversationAuthorizations(context.conversation)) {
    if (part.state !== "required") continue;
    items.push({
      key: `auth:${part.attemptId ?? `${part.turnId}:${part.stepIndex}:${part.name}`}`,
      kind: "auth",
      part,
    });
  }
  return items;
}

/** Follows a passed-up request down the followed sessions to the agent that asked. */
function requesterPath(context: ViewContext, input: ConversationInput): string[] {
  const path: string[] = [];
  const requestId = input.request.requestId;
  let conversation = context.conversation;
  let taskId = input.taskId;
  let facts = context.facts;
  for (let depth = 0; taskId !== undefined && depth < 8; depth += 1) {
    const task: ConversationTask | undefined = conversation.tasks[taskId];
    if (task === undefined) break;
    const agent = agentToolSession(conversation, task);
    const isAgent =
      agent !== undefined || Object.keys(task.calls).some((id) => facts.agentCallIds.has(id));
    // The root knows every call's ordinal, which tells apart parallel calls to one agent.
    const rootCall =
      depth === 0
        ? Object.values(task.calls)
            .map((call) => context.agentCalls.get(call.callId))
            .findLast((call) => call !== undefined)
        : undefined;
    path.push(
      rootCall !== undefined
        ? agentCallName(rootCall)
        : isAgent
          ? `subagent:${agent?.name ?? task.name}`
          : `task:${task.name}`,
    );
    const observation = agent?.observation;
    const child =
      observation === undefined || observation.status === "not-followed"
        ? undefined
        : observation.conversation;
    if (child === undefined) break;
    conversation = child;
    taskId = child.inputs[requestId]?.taskId;
    facts = EMPTY_FACTS;
  }
  return path;
}

/** The answer a settled or responded input carries, as the option's label or the typed text. */
export function inputAnswer(input: ConversationInput): string | undefined {
  const response = input.response;
  if (response === undefined) return input.outcome;
  const option = input.request.options?.find((candidate) => candidate.id === response.optionId);
  return option?.label ?? response.text ?? response.optionId;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** A short, single-line description of a call's input. */
export function describeInput(input: unknown): string | undefined {
  if (typeof input === "string") return oneLine(input);
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["message", "question", "prompt", "query", "command", "url", "path"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return oneLine(value);
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    }
    if (parts.length === 3) break;
  }
  return parts.length === 0 ? undefined : parts.join(", ");
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  if (milliseconds < 1_000) return `${Math.max(0.1, milliseconds / 1_000).toFixed(1)}s`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
