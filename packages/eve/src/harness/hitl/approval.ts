import type { ModelMessage, ToolResultPart } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import {
  createActionResultEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
  type InputResolution,
} from "#protocol/message.js";
import type { HarnessToolMap } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

import type { Command } from "./command.js";
import type { Input, RequestAt } from "./input.js";
import type { Reduced, OpenApproval } from "./state.js";
import {
  heldCalls,
  settleStep,
  holdStep,
  withMessages,
  withoutCalls,
  withResults,
  type HeldStepState,
} from "./held-step.js";

// The tool approval rules. A model step's calls open one request each; the
// step's approvals resolve together once each has an answer, or when the turn
// moves past them. The host runs the approved calls (`next()` is
// `{ run: "approved" }`); every other call gets a not-run result. The step is
// held out of history and settles once every call it made has a result.

/** The state the approval rules read and change. */
interface ApprovalState extends HeldStepState {
  readonly requests: Readonly<Record<string, { readonly kind: string }>>;
  readonly grants: readonly string[];
}

type Outcome = "approved" | "denied" | "invalid" | "ignored";

const NOT_RUN_REASONS: Record<Exclude<Outcome, "approved"> | "cancelled", string> = {
  cancelled: "Cancelled before anyone answered.",
  denied: "Tool execution was denied.",
  ignored: "Ignored because the user continued without responding.",
  invalid: "Invalid approval response.",
};

/**
 * What a model step's approval requests ask, read from the tools that made
 * them: the key a `once()` approval grants, and whether a response policy
 * decides who may answer.
 */
export function approvalsRequested(input: {
  readonly at: RequestAt;
  /** The step's response, held out of history until every call it made has a result. */
  readonly messages: readonly ModelMessage[];
  readonly requester: SessionAuthContext | null;
  readonly requests: readonly InputRequest[];
  readonly tools: HarnessToolMap;
}): Extract<Input, { readonly type: "approval.requested" }> {
  const approvalKeys: Record<string, string> = {};
  const responsePolicyRequestIds: string[] = [];
  for (const request of input.requests) {
    const tool = input.tools.get(request.action.toolName);
    if (tool?.approvalKey !== undefined) {
      approvalKeys[request.requestId] = tool.approvalKey(request.action.input);
    }
    const approval = tool?.approval;
    if (
      approval !== undefined &&
      typeof approval !== "function" &&
      approval.response !== undefined
    ) {
      responsePolicyRequestIds.push(request.requestId);
    }
  }
  return {
    approvalKeys,
    at: input.at,
    messages: input.messages,
    requester: input.requester,
    requests: input.requests,
    responsePolicyRequestIds,
    type: "approval.requested",
  };
}

/**
 * Drops the AI SDK's approval request and response parts, and messages they
 * leave empty: eve answers approvals itself, so they never reach history.
 */
export function withoutApprovalParts(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.flatMap((message): ModelMessage[] => {
    if (message.role === "assistant" && typeof message.content !== "string") {
      const content = message.content.filter((part) => part.type !== "tool-approval-request");
      if (content.length === message.content.length) return [message];
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    if (message.role === "tool") {
      const content = message.content.filter((part) => part.type !== "tool-approval-response");
      if (content.length === message.content.length) return [message];
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    return [message];
  });
}

/**
 * A model step's calls ask for approval: each becomes an open request, the
 * step is held out of history, and the turn waits. A request id already open,
 * or repeated among them, throws before anything is published: it would
 * replace a call the turn still tracks.
 */
export function openApprovals<S extends ApprovalState>(
  state: S,
  input: {
    readonly at: RequestAt;
    readonly messages: readonly ModelMessage[];
    readonly requests: readonly InputRequest[];
    readonly requester: SessionAuthContext | null;
    readonly approvalKeys: Readonly<Record<string, string>>;
    readonly responsePolicyRequestIds: readonly string[];
  },
): Reduced<S> {
  // Every anonymous caller shares one identity, so an anonymous requester
  // can't be told apart from another anonymous person: record none.
  const requester = input.requester?.principalType === "anonymous" ? null : input.requester;
  const requests: Record<string, { readonly kind: string }> = { ...state.requests };
  for (const request of input.requests) {
    if (request.requestId in requests) {
      throw new TypeError(`Duplicate input request id: ${JSON.stringify(request.requestId)}.`);
    }
    const approval: OpenApproval = {
      approvalKey: input.approvalKeys[request.requestId] ?? request.action.toolName,
      at: input.at,
      kind: "tool-approval",
      request,
      requester,
      ...(input.responsePolicyRequestIds.includes(request.requestId) && {
        responsePolicy: true as const,
      }),
    };
    requests[request.requestId] = approval;
  }
  return {
    events: [publish(createInputRequestedEvent({ ...input.at, requests: input.requests }))],
    state: holdStep({ ...state, requests }, input.at, input.messages),
  };
}

/**
 * Answers arrived. Each answers its open approval, the last one winning; the
 * step's approvals resolve once every one has an answer. Until then the
 * answers wait in state and the turn keeps waiting.
 */
export function answerApprovals<S extends ApprovalState>(
  state: S,
  responses: readonly InputResponse[],
): Reduced<S> {
  const recorded = recordAnswers(state, responses);
  const open = openApprovalsOf(recorded);
  if (open.length === 0 || open.some((approval) => approval.answer === undefined)) {
    return { events: [], state: recorded };
  }
  return resolveApprovals(recorded);
}

/**
 * A message that answers nothing steers the turn past its approvals: the
 * approvals nobody answered are ignored, and the answers already given stand.
 *
 * Only the turn's own person reaches a waiting turn with a message; the runtime
 * queues anyone else's for the next turn.
 */
export function steerPastApprovals<S extends ApprovalState>(state: S): Reduced<S> {
  return openApprovalsOf(state).length === 0 ? { events: [], state } : resolveApprovals(state);
}

/** Whether a response policy decides who may answer this open approval. */
export function isPolicyGated(state: ApprovalState, requestId: string): boolean {
  const open = state.requests[requestId];
  return isOpenApproval(open) && open.responsePolicy === true;
}

/**
 * The turn was cancelled: every open approval is cancelled, and its call never
 * runs. Its not-run result joins the held step as the step is cancelled
 * (see `cancelStep`), or history directly for a step parked before steps were
 * held out of history, whose calls are already there.
 */
export function cancelApprovals<S extends ApprovalState>(state: S): Reduced<S> {
  const open = openApprovalsOf(state);
  if (open.length === 0) return { events: [], state };
  const events: Command[] = open.map((approval) =>
    publish(
      createInputResolvedEvent({
        ...approval.at,
        resolutions: [
          {
            kind: approval.request.kind,
            outcome: "cancelled",
            requestId: approval.request.requestId,
          },
        ],
      }),
    ),
  );
  if (state.held === undefined) {
    events.push({
      message: notRunMessage(open.map((approval) => notRunPart(approval, "cancelled"))),
      type: "appendHistory",
    });
  }
  return { events, state: { ...state, requests: withoutApprovals(state.requests) } };
}

/**
 * Calls of the held step settled: approved calls eve ran, or its runtime
 * calls. Their results join the step; `stopped`, the calls that asked for a
 * authorization, leave it, and `running`, approved calls that run as runtime work,
 * keep it waiting for their results. Once none of its calls waits, on a
 * person or on runtime work, the step joins history and the turn goes on.
 */
export function settleCalls<S extends ApprovalState>(
  state: S,
  results: readonly ModelMessage[],
  running: readonly RuntimeWorkflowTaskRequest[] = [],
  stopped: readonly string[] = [],
): Reduced<S> {
  const { held } = state;
  // A step parked before steps were held out of history has its calls there.
  if (held === undefined) {
    return { events: results.map((message) => ({ message, type: "appendHistory" })), state };
  }
  const joined = withMessages(held.messages, results);
  // Calls that asked for an authorization leave the step; the model calls them again.
  const messages = stopped.length === 0 ? joined : withoutCalls(joined, new Set(stopped));
  const tasks = [...(held.runtime?.tasks ?? []), ...running];
  const settled = {
    ...state,
    held: {
      ...held,
      messages,
      ...((held.runtime !== undefined || running.length > 0) && { runtime: { tasks } }),
    },
  };
  if ((heldCalls(settled.held, askedCallIds(state))?.calls.length ?? 0) > 0) {
    return { events: [], state: settled };
  }
  return settleStep(settled, []);
}

/** The calls whose approvals are open, which wait on a person. */
export function askedCallIds(state: ApprovalState): ReadonlySet<string> {
  return new Set(openApprovalsOf(state).map((approval) => approval.request.action.callId));
}

/**
 * The approval keys `once()` approvals granted, for approval policies to read.
 * A grant is hidden while an approval for its key still waits, so the policy
 * keeps asking for that call.
 */
export function grantedApprovalKeys(state: ApprovalState): ReadonlySet<string> {
  const waiting = new Set(openApprovalsOf(state).map((approval) => approval.approvalKey));
  return new Set(state.grants.filter((key) => !waiting.has(key)));
}

/**
 * Resolves the step's approvals together: one `input.resolved` at the asking
 * step, a not-run result and a rejected `action.result` for each call that
 * won't run; the rest wait on the held step for the turn to run them.
 * An approval nobody answered is ignored.
 */
function resolveApprovals<S extends ApprovalState>(state: S): Reduced<S> {
  const open = openApprovalsOf(state);
  const resolutions: InputResolution[] = [];
  const notRun: ToolResultPart[] = [];
  const rejected: Command[] = [];
  const approved: InputRequest[] = [];
  const grants = new Set(state.grants);
  for (const approval of open) {
    const outcome = outcomeOf(approval.answer);
    resolutions.push({
      kind: approval.request.kind,
      outcome,
      requestId: approval.request.requestId,
      ...(approval.answer !== undefined && { response: approval.answer }),
    });
    if (outcome === "approved") {
      approved.push(approval.request);
      grants.add(approval.approvalKey);
      continue;
    }
    notRun.push(notRunPart(approval, outcome));
    rejected.push(
      publish(
        createActionResultEvent({
          ...approval.at,
          rejected: true,
          result: {
            callId: approval.request.action.callId,
            isError: true,
            kind: "tool-result",
            output: {
              approval: { requestId: approval.request.requestId, status: outcome },
              code: "TOOL_EXECUTION_DENIED",
              message: NOT_RUN_REASONS[outcome],
              tool: { result: "not_run" },
            },
            toolName: approval.request.action.toolName,
          },
        }),
      ),
    );
  }
  // At most one step has open approvals, so they share its coordinates.
  const at = open[0]!.at;
  const events: Command[] = [
    publish(createInputResolvedEvent({ ...at, resolutions })),
    ...rejected,
  ];
  const resolved = { ...state, grants: [...grants], requests: withoutApprovals(state.requests) };
  if (approved.length === 0) {
    const settled = settleCalls(resolved, notRun.length === 0 ? [] : [notRunMessage(notRun)]);
    return { events: [...events, ...settled.events], state: settled.state };
  }
  // The host runs the approved calls (`approvedCalls`); the step stays held
  // until their results settle it. A step parked before
  // steps were held out of history has its calls there: it holds only the
  // results, which join history after them.
  const step = resolved.held ?? { at, messages: [] };
  const held = { ...step, approved, messages: withResults(step.messages, notRun) };
  return { events, state: { ...resolved, held } };
}

/** An approval's outcome from its answer; a relayed approval resolves the same way. */
export function outcomeOf(answer: InputResponse | undefined): Outcome {
  if (answer === undefined) return "ignored";
  if (answer.optionId === "approve") return "approved";
  // ACP answers with "deny"; eve's own approval prompts offer "cancel".
  if (answer.optionId === "cancel" || answer.optionId === "deny") return "denied";
  return "invalid";
}

function recordAnswers<S extends ApprovalState>(state: S, responses: readonly InputResponse[]): S {
  const requests: Record<string, { readonly kind: string }> = { ...state.requests };
  for (const response of responses) {
    const open = requests[response.requestId];
    if (!isOpenApproval(open)) continue;
    const answered: OpenApproval = { ...open, answer: response };
    requests[response.requestId] = answered;
  }
  return { ...state, requests };
}

function openApprovalsOf(state: ApprovalState): OpenApproval[] {
  return Object.values(state.requests).filter(isOpenApproval);
}

function isOpenApproval(value: { readonly kind: string } | undefined): value is OpenApproval {
  return value?.kind === "tool-approval";
}

function withoutApprovals<R extends { readonly kind: string }>(
  requests: Readonly<Record<string, R>>,
): Readonly<Record<string, R>> {
  return Object.fromEntries(
    Object.entries(requests).filter(([, request]) => !isOpenApproval(request)),
  );
}

function notRunPart(approval: OpenApproval, outcome: keyof typeof NOT_RUN_REASONS): ToolResultPart {
  return {
    output: { reason: NOT_RUN_REASONS[outcome], type: "execution-denied" },
    toolCallId: approval.request.action.callId,
    toolName: approval.request.action.toolName,
    type: "tool-result",
  };
}

function notRunMessage(parts: readonly ToolResultPart[]): ModelMessage {
  return { content: [...parts], role: "tool" };
}

function publish(event: Extract<Command, { type: "publish" }>["event"]): Command {
  return { event, type: "publish" };
}
