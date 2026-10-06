import type { ModelMessage, ToolResultPart } from "ai";

import { pendingTaskToolCalls, type TaskToolCall } from "#execution/tasks/calls.js";
import type { StepInput } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";

import type { Command } from "./command.js";
import type { RequestAt } from "./input.js";
import type { Reduced, HeldStep } from "./state.js";

// History is append-only, and a call joins it only with its result. A model
// step whose calls wait, on a person or on runtime work, is held: its
// response stays here, out of history, and results join it as they arrive.
// Once every call it made has a result, the whole step is appended at once.

/** The state the held-step rules read and change. */
export interface HeldStepState {
  readonly held?: HeldStep;
  /** Turn input that waited behind a step's calls, for the turn's next step to read. */
  readonly queued?: StepInput;
}

/** What a call of the held step waits on: a person's answer, or runtime work. */
export type HeldCallWait = "person" | "runtime";

/**
 * A call of the held step without a result. A call that asked for a
 * authorization is never one: it leaves its step, and the model calls it again.
 */
export interface HeldCall {
  readonly callId: string;
  readonly toolName: string;
  readonly waitsOn: HeldCallWait;
}

/** The held step as the runtime reads it. */
export interface HeldCalls {
  readonly at: RequestAt;
  readonly calls: readonly HeldCall[];
  /** The workflow runs its runtime calls without a result start. */
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  /** Its task tool calls without a result, which the session answers. */
  readonly taskToolCalls: readonly TaskToolCall[];
}

/** What the model reads for a runtime call its turn's cancellation stopped before it settled. */
export const CANCELLED_CALL_RESULT = "The turn was cancelled before this call finished.";

const CANCELLED_BEFORE_ANSWER = "Cancelled before anyone answered.";

/**
 * Reads the held step: each call that waits, tagged with what it waits
 * on. `asked` names the calls whose approvals are open.
 */
export function heldCalls(
  step: HeldStep | undefined,
  asked: ReadonlySet<string>,
): HeldCalls | undefined {
  if (step === undefined) return undefined;
  const answered = answeredCallIds(step.messages);
  const tasks = (step.runtime?.tasks ?? []).filter((task) => !answered.has(task.callId));
  const taskToolCalls = step.runtime === undefined ? [] : pendingTaskToolCalls(step.messages);
  const unanswered = unansweredCalls(step.messages);
  const toolNames = new Map(unanswered.map((call) => [call.toolCallId, call.toolName]));
  const calls: HeldCall[] = [
    ...tasks.map((task) => ({
      callId: task.callId,
      toolName: task.toolName,
      waitsOn: "runtime" as const,
    })),
    ...taskToolCalls.map((call) => ({
      callId: call.callId,
      toolName: toolNames.get(call.callId) ?? call.kind,
      waitsOn: "runtime" as const,
    })),
  ];
  for (const call of unanswered) {
    if (asked.has(call.toolCallId)) {
      calls.push({ callId: call.toolCallId, toolName: call.toolName, waitsOn: "person" });
    }
  }
  return { at: step.at, calls, taskToolCalls, tasks };
}

/** Holds a model step out of history, unless one already is: every rule on one step holds the same one. */
export function holdStep<S extends HeldStepState>(
  state: S,
  at: RequestAt,
  messages: readonly ModelMessage[],
): S {
  if (state.held !== undefined) return state;
  return { ...state, held: { at, messages: [...messages] } };
}

/**
 * Some of the step's calls run as runtime work: the step waits, out of
 * history, for their results too.
 */
export function dispatchCalls<S extends HeldStepState>(
  state: S,
  input: {
    readonly at: RequestAt;
    readonly messages: readonly ModelMessage[];
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  },
): S {
  const held = holdStep(state, input.at, input.messages).held!;
  const tasks = [...(held.runtime?.tasks ?? []), ...input.tasks];
  assertUniqueCallIds(tasks);
  return { ...state, held: { ...held, runtime: { tasks } } };
}

/**
 * The turn ran the calls a person approved: they leave the step, and the
 * turn input that arrived with the answers, `following`, waits behind the
 * step until it joins history.
 */
export function ranApproved<S extends HeldStepState>(
  state: S,
  following: StepInput | undefined,
): S {
  const step = state.held;
  if (step?.approved === undefined) return state;
  const { approved: _ran, ...rest } = step;
  return { ...state, held: { ...rest, ...(following !== undefined && { following }) } };
}

/** The held step's approved calls the turn has yet to run, at the step that asked. */
export function approvedCallsOf(
  step: HeldStep | undefined,
): { readonly at: RequestAt; readonly requests: readonly InputRequest[] } | undefined {
  if (step?.approved === undefined || step.approved.length === 0) return undefined;
  return { at: step.at, requests: step.approved };
}

/**
 * The turn was cancelled: the held step joins history with a not-run
 * result for every call still without one. A call that waited on a person
 * never ran; a runtime call was stopped before it finished.
 */
export function cancelStep<S extends HeldStepState>(cancelled: S): Reduced<S> {
  // Input queued behind calls that already joined goes with the turn too.
  const { queued: _queued, ...unqueued } = cancelled;
  const state = unqueued as S;
  if (state.held === undefined) return { events: [], state };
  const runtime = heldCalls(state.held, new Set())!.calls;
  const stopped = new Set(runtime.map((call) => call.callId));
  const results: ToolResultPart[] = runtime.map((call) => ({
    output: { type: "text", value: CANCELLED_CALL_RESULT },
    toolCallId: call.callId,
    toolName: call.toolName,
    type: "tool-result",
  }));
  for (const call of unansweredCalls(state.held.messages)) {
    if (stopped.has(call.toolCallId)) continue;
    results.push({
      output: { reason: CANCELLED_BEFORE_ANSWER, type: "execution-denied" },
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      type: "tool-result",
    });
  }
  // The turn's input that waited behind the calls goes with the cancelled turn.
  return settleStep(state, results, { following: false });
}

/**
 * Adds results to the step: they join its trailing tool message, so the
 * step's calls answer as one tool response.
 */
export function withResults(
  messages: readonly ModelMessage[],
  results: readonly ToolResultPart[],
): ModelMessage[] {
  if (results.length === 0) return [...messages];
  const tail = messages.at(-1);
  if (tail?.role === "tool") {
    return [...messages.slice(0, -1), { content: [...tail.content, ...results], role: "tool" }];
  }
  return [...messages, { content: [...results], role: "tool" }];
}

/**
 * The calls in `messages` without a result there. Provider-executed calls
 * carry their result in the assistant message, so they count as answered.
 */
export function unansweredCalls(
  messages: readonly ModelMessage[],
): { readonly toolCallId: string; readonly toolName: string }[] {
  const answered = answeredCallIds(messages);
  const calls: { toolCallId: string; toolName: string }[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.providerExecuted === true) continue;
      if (!answered.has(part.toolCallId)) calls.push(part);
    }
  }
  return calls;
}

function answeredCallIds(messages: readonly ModelMessage[]): Set<string> {
  const answered = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") answered.add(part.toolCallId);
    }
  }
  return answered;
}

/**
 * Appends the held step to history, with `results` joined to it, and
 * clears it. Without a held step (one parked before steps were held out
 * of history), `results` alone are appended after the calls already there.
 */
export function settleStep<S extends HeldStepState>(
  state: S,
  results: readonly ToolResultPart[],
  options: { readonly following: boolean } = { following: true },
): Reduced<S> {
  const messages = withResults(state.held?.messages ?? [], results);
  const following = state.held?.following;
  const { held: _released, ...rest } = state;
  const events: Command[] = messages.map((message) => ({
    message,
    type: "appendHistory" as const,
  }));
  if (following === undefined || !options.following) return { events, state: rest as S };
  // The turn's next step reads it, after the step's results.
  return { events, state: { ...rest, queued: following } as S };
}

/** The turn's step reads the input that waited behind the last step's calls. */
export function takeQueued<S extends HeldStepState>(state: S): Reduced<S> {
  const { queued, ...rest } = state;
  if (queued === undefined) return { events: [], state };
  return { events: [{ input: queued, type: "resumeInput" }], state: rest as S };
}

/** Adds messages to the step; tool messages join its trailing tool response. */
export function withMessages(
  messages: readonly ModelMessage[],
  more: readonly ModelMessage[],
): ModelMessage[] {
  let joined = [...messages];
  for (const message of more) {
    joined =
      message.role === "tool"
        ? withResults(
            joined,
            message.content.filter((part): part is ToolResultPart => part.type === "tool-result"),
          )
        : [...joined, message];
  }
  return joined;
}

/**
 * `messages` without these calls and their results, so the model calls them
 * again once authorized. An assistant message the calls leave with only text
 * goes too: it narrated calls that never happened.
 */
export function withoutCalls(
  messages: readonly ModelMessage[],
  callIds: ReadonlySet<string>,
): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const stopped = message.content.some(
        (part) => part.type === "tool-call" && callIds.has(part.toolCallId),
      );
      const content = message.content.filter(
        (part) => part.type !== "tool-call" || !callIds.has(part.toolCallId),
      );
      const hasOtherCall = content.some((part) => part.type === "tool-call");
      return content.length === 0 || (stopped && !hasOtherCall) ? [] : [{ ...message, content }];
    }
    if (message.role === "tool") {
      const content = message.content.filter(
        (part) => part.type !== "tool-result" || !callIds.has(part.toolCallId),
      );
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    return [message];
  });
}

/**
 * Rejects runtime calls whose ids repeat, before any result can bind to the
 * wrong one. Kept here, not shared with coordination, because human input
 * runs in the workflow body, where coordination's imports can't.
 */
function assertUniqueCallIds(requests: readonly { readonly callId: string }[]): void {
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.callId)) {
      throw new Error(`Coordination batch contains duplicate callId "${request.callId}".`);
    }
    seen.add(request.callId);
  }
}
