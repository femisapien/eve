import type { ModelMessage, ToolSet, TypedToolCall, TypedToolError, TypedToolResult } from "ai";

import { contextStorage } from "#context/container.js";
import { SessionKey, AuthKey } from "#context/keys.js";
import type { SessionAuthContext } from "#channel/types.js";
import { commitCallEntry, isTaskTool } from "#execution/tasks/model-step.js";
import { pendingTaskToolCalls } from "#execution/tasks/calls.js";
import {
  createRuntimeToolResultFromStepResult,
  createRuntimeToolResultFromToolError,
  createToolResultMessagePartFromToolError,
} from "#harness/action-result-helpers.js";
import { runApprovedToolCall } from "#harness/tools.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  buildResolvedInputBatch,
  resolveApprovalOutcome,
  TOOL_EXECUTION_DENIED_MESSAGE,
  type ResolvedInputBatch,
} from "#harness/input-request-resolution.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import { withdrawProxyInputRequests } from "#harness/proxy-input-requests.js";
import {
  createWorkflowTaskRequestFromToolCall,
  resolveToolCallInputObject,
  runtimeResultToToolResultPart,
} from "#harness/runtime-calls.js";
import {
  callOrigin,
  dropCall,
  findCall,
  grantApprovals,
  openApprovalRequests,
  settleCall,
  updateCall,
  type EventCoordinates,
  type ParkedCall,
  type TurnState,
  type ToolResultPart,
} from "#harness/turn-state.js";
import {
  isInlineAuthorizationToolResult,
  withoutCalls,
} from "#harness/inline-tool-authorization.js";
import { createCancelledCallEvent, SIGN_IN_REQUIRED } from "#harness/cancelled-calls.js";
import { isTurnCancellation } from "#harness/turn-cancellation.js";
import { projectResultPresentation } from "#harness/tool-presentation.js";
import { resolveTextResponses } from "#harness/step-input.js";
import type { HarnessEmitFn, HarnessSession, HarnessToolMap, StepInput } from "#harness/types.js";
import { createActionResultEvent } from "#protocol/message.js";
import type { RuntimeActionResult, RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

const TOOL_EXECUTION_DENIED_CODE = "TOOL_EXECUTION_DENIED";
const APPROVED_TOOL_UNAVAILABLE_MESSAGE =
  "The approved tool is no longer available. Request a new tool call and approval.";
const APPROVED_TOOL_CONNECTION_CHANGED_MESSAGE =
  "The connection for this tool call changed or is unavailable. Request a new tool call and approval.";

/** Tools whose calls the runtime answers instead of the model step. */
export function isDeferredHarnessTool(tool: HarnessToolDefinition | undefined): boolean {
  return tool?.workflowId !== undefined || isTaskTool(tool);
}

/**
 * Turns a model response's unanswered calls into parked calls: approvals wait
 * on a person, workflow calls wait for their run, and task tool calls wait for
 * the session to answer them.
 */
export function createParkedCalls(input: {
  readonly approvalRequests: readonly InputRequest[];
  readonly deferredToolCalls: readonly TypedToolCall<ToolSet>[];
  readonly replayIdentity?: (toolName: string) => string | undefined;
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
  readonly responseTools: HarnessToolMap;
  readonly turnId: string;
}): { readonly calls: readonly ParkedCall[]; readonly session: HarnessSession } {
  let { session } = input;
  const calls: ParkedCall[] = [];
  for (const request of input.approvalRequests) {
    const policy = input.responseTools.get(request.action.toolName)?.approval;
    const replayIdentity = input.replayIdentity?.(request.action.toolName);
    const approval: { request: InputRequest; replayIdentity?: string; responsePolicy?: true } = {
      request,
    };
    if (replayIdentity !== undefined) approval.replayIdentity = replayIdentity;
    if (policy !== undefined && typeof policy !== "function" && policy.response !== undefined) {
      approval.responsePolicy = true;
    }
    calls.push({
      approval,
      callId: request.action.callId,
      input: request.action.input,
      status: "awaiting-approval",
      toolName: request.action.toolName,
    });
  }
  const taskCalls = new Map(
    pendingTaskToolCalls(input.responseMessages).map((call) => [call.callId, call]),
  );
  for (const toolCall of input.deferredToolCalls) {
    const toolInput = resolveToolCallInputObject(toolCall.input, {
      callId: toolCall.toolCallId,
      toolName: toolCall.toolName,
    });
    const task = taskCalls.get(toolCall.toolCallId);
    if (task !== undefined) {
      calls.push({
        callId: toolCall.toolCallId,
        input: toolInput,
        status: "running",
        task,
        toolName: toolCall.toolName,
      });
      continue;
    }
    const workflow = createWorkflowCall({
      callId: toolCall.toolCallId,
      input: toolInput,
      modelInput: toolCall.input,
      session,
      toolName: toolCall.toolName,
      tools: input.tools,
      turnId: input.turnId,
    });
    session = workflow.session;
    calls.push(workflow.call);
  }
  // Results commit in the order the model made the calls.
  const order = input.responseMessages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.flatMap((part) => (part.type === "tool-call" ? [part.toolCallId] : []))
      : [],
  );
  calls.sort((a, b) => order.indexOf(a.callId) - order.indexOf(b.callId));
  return { calls, session };
}

function createWorkflowCall(input: {
  readonly callId: string;
  readonly input: Record<string, unknown>;
  readonly modelInput: unknown;
  readonly session: HarnessSession;
  readonly toolName: string;
  readonly tools: HarnessToolMap;
  readonly turnId: string;
}): { readonly call: ParkedCall; readonly session: HarnessSession } {
  const definition = input.tools.get(input.toolName);
  const committed = commitCallEntry(input.session, {
    callId: input.callId,
    definition,
    input: input.input as ParkedCall["input"],
    toolName: input.toolName,
    turnId: input.turnId,
  });
  const request = createWorkflowTaskRequestFromToolCall({
    entry: committed.entry,
    input: committed.input,
    toolCall: { input: input.modelInput, toolCallId: input.callId, toolName: input.toolName },
    tools: input.tools,
  });
  return {
    call: {
      callId: input.callId,
      input: input.input as ParkedCall["input"],
      status: "ready",
      toolName: input.toolName,
      workflow: { request },
    },
    session: committed.session,
  };
}

/** Auth of the caller whose turn parks approvals; anonymous callers record none. */
export function currentRequester(): SessionAuthContext | null {
  const context = contextStorage.getStore();
  const auth = context?.get(AuthKey) ?? context?.get(SessionKey)?.auth.current ?? null;
  return auth?.principalType === "anonymous" ? null : auth;
}

// ---------------------------------------------------------------------------
// Runtime results
// ---------------------------------------------------------------------------

/**
 * Settles the calls these runtime results answer and projects each onto the
 * stream at the step that made the call. Results for calls the session no
 * longer waits on are ignored.
 */
export async function settleRuntimeResults(input: {
  readonly emit?: HarnessEmitFn;
  readonly results: readonly RuntimeActionResult[] | undefined;
  readonly session: HarnessSession;
  readonly turnState: TurnState;
  readonly tools: HarnessToolMap;
}): Promise<{ readonly turnState: TurnState; readonly session: HarnessSession }> {
  let { turnState, session } = input;
  const seen = new Set<string>();
  for (const result of input.results ?? []) {
    if (seen.has(result.callId)) continue;
    const call = findCall(turnState, result.callId);
    if (call === undefined || (call.status !== "running" && call.status !== "ready")) continue;
    seen.add(result.callId);
    const origin = callOrigin(turnState, result.callId)!;
    const run = call.workflow?.run;
    if (run !== undefined) {
      // A finished run's unanswered questions must not reach it after it ends.
      const withdrawn = withdrawProxyInputRequests(
        session,
        (route) => (route.runId ?? route.workflowAsk?.runId) === run.runId,
      );
      session = withdrawn.session;
      for (const event of withdrawn.events) await input.emit?.(event);
    }
    turnState = settleCall(
      turnState,
      result.callId,
      await runtimeResultToToolResultPart(result, input.tools),
    );
    await input.emit?.(createActionResultEvent({ result, ...origin }));
  }
  return { turnState, session };
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface ApprovalDecisions {
  readonly turnState: TurnState;
  /** Denials, attributed to the step that requested approval. */
  readonly rejected: readonly {
    readonly origin: EventCoordinates;
    readonly results: readonly RuntimeToolResultActionResult[];
  }[];
  readonly resolved: readonly ResolvedInputBatch[];
  readonly session: HarnessSession;
}

/**
 * Records responses on the approvals they answer. A step's approvals resolve
 * together once each has a decision: denials settle, approved workflow calls
 * become ready to dispatch, and approved inline calls wait for eve to run them.
 */
export function decideApprovals(input: {
  readonly turnState: TurnState;
  readonly responses: readonly InputResponse[];
  readonly resolveApprovalKey: (request: InputRequest) => string | undefined;
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): ApprovalDecisions {
  let { turnState, session } = input;
  const responses = new Map(input.responses.map((response) => [response.requestId, response]));
  for (const request of openApprovalRequests(turnState)) {
    const response = responses.get(request.requestId);
    if (response === undefined) continue;
    // The stream reported the first decision settled, so it stands.
    turnState = updateCall(turnState, request.action.callId, (call) =>
      call.approval!.decision === undefined
        ? { ...call, approval: { ...call.approval!, decision: response } }
        : call,
    );
  }

  const resolved: ResolvedInputBatch[] = [];
  const rejected: ApprovalDecisions["rejected"][number][] = [];
  for (const step of turnState.steps) {
    const approvals = step.calls.filter(
      (call) => call.status === "awaiting-approval" && call.approval !== undefined,
    );
    if (approvals.length === 0 || approvals.some((call) => call.approval!.decision === undefined)) {
      continue;
    }
    const denials: RuntimeToolResultActionResult[] = [];
    const grants: string[] = [];
    for (const call of approvals) {
      const approval = call.approval!;
      const outcome = resolveApprovalOutcome(approval.decision);
      if (!outcome.approved) {
        turnState = settleCall(turnState, call.callId, {
          output: { reason: outcome.reason, type: "execution-denied" },
          toolCallId: call.callId,
          toolName: call.toolName,
          type: "tool-result",
        });
        denials.push({
          callId: call.callId,
          isError: true,
          kind: "tool-result",
          output: {
            approval: { requestId: approval.request.requestId, status: outcome.status },
            code: TOOL_EXECUTION_DENIED_CODE,
            message: outcome.reason ?? TOOL_EXECUTION_DENIED_MESSAGE,
            tool: { result: "not_run" },
          },
          toolName: call.toolName,
        });
        continue;
      }
      grants.push(input.resolveApprovalKey(approval.request) ?? call.toolName);
      if (input.tools.get(call.toolName)?.workflowId === undefined) {
        turnState = updateCall(turnState, call.callId, (current) => ({
          ...current,
          status: "approved",
        }));
        continue;
      }
      const workflow = createWorkflowCall({
        callId: call.callId,
        input: call.input,
        modelInput: call.input,
        session,
        toolName: call.toolName,
        tools: input.tools,
        turnId: step.origin.turnId,
      });
      session = workflow.session;
      turnState = updateCall(turnState, call.callId, (current) => ({
        ...current,
        status: "ready",
        workflow: workflow.call.workflow,
      }));
    }
    turnState = grantApprovals(turnState, grants);
    const batch = buildResolvedInputBatch(
      {
        event: step.origin,
        requests: approvals.map((call) => call.approval!.request),
        toolReplayIdentities: Object.fromEntries(
          approvals.flatMap((call) =>
            call.approval!.replayIdentity === undefined
              ? []
              : [[call.approval!.request.requestId, call.approval!.replayIdentity]],
          ),
        ),
      },
      approvals.map((call) => call.approval!.decision!),
    );
    if (batch !== undefined) resolved.push(batch);
    if (denials.length > 0) rejected.push({ origin: step.origin, results: denials });
  }
  return { turnState, rejected, resolved, session };
}

/**
 * Resolves a free-text reply ("approve", "1") into approval responses. Text
 * is unambiguous only while one step awaits approval, and never answers an
 * approval whose tool authorizes its responders.
 */
export function resolveApprovalText(
  turnState: TurnState,
  input: StepInput | undefined,
): StepInput | undefined {
  const steps = turnState.steps.filter((step) =>
    step.calls.some((call) => call.status === "awaiting-approval"),
  );
  if (steps.length !== 1) return input;
  return resolveTextResponses(
    steps[0]!.calls.flatMap((call) =>
      call.status === "awaiting-approval" &&
      call.approval !== undefined &&
      call.approval.responsePolicy !== true
        ? [call.approval.request]
        : [],
    ),
    input,
  );
}

/** Approval keys granted in this context, minus any whose request is still open. */
export function effectiveGrants(
  turnState: TurnState,
  resolveApprovalKey: (request: InputRequest) => string | undefined,
): ReadonlySet<string> {
  const grants = new Set(turnState.grants);
  for (const request of openApprovalRequests(turnState)) {
    if (!isApprovalRequest(request)) continue;
    grants.delete(resolveApprovalKey(request) ?? request.action.toolName);
  }
  return grants;
}

export function resolveApprovalKeyFromTools(
  tools: HarnessToolMap,
): (request: InputRequest) => string | undefined {
  return (request) => tools.get(request.action.toolName)?.approvalKey?.(request.action.input);
}

// ---------------------------------------------------------------------------
// Approved inline calls
// ---------------------------------------------------------------------------

/**
 * Runs approved inline calls. eve runs them itself rather than replaying the
 * approval through the AI SDK, so results settle before the next model call
 * and new input needs no ordering constraint against the approval.
 */
export async function runApprovedCalls(input: {
  readonly abortSignal?: AbortSignal;
  readonly emit?: HarnessEmitFn;
  readonly coordinates: EventCoordinates;
  readonly turnState: TurnState;
  readonly messages: readonly ModelMessage[];
  readonly replayIdentity?: (toolName: string) => string | undefined;
  readonly toolsFor: (origin: EventCoordinates) => Promise<HarnessToolMap>;
}): Promise<{
  readonly authorizationResults: readonly TypedToolResult<ToolSet>[];
  readonly turnState: TurnState;
}> {
  let { turnState } = input;
  const authorizationResults: TypedToolResult<ToolSet>[] = [];
  for (const step of turnState.steps) {
    const approved = step.calls.filter((call) => call.status === "approved");
    if (approved.length === 0) continue;
    const tools = await input.toolsFor(step.origin);
    for (const call of approved) {
      const executed = await runApprovedCall({
        abortSignal: input.abortSignal,
        call,
        definition: tools.get(call.toolName),
        messages: input.messages,
        replayIdentity: input.replayIdentity,
      });
      if (executed.authorization !== undefined) {
        turnState = dropCall(turnState, call.callId, (response) =>
          withoutCalls(response, new Set([call.callId])),
        );
        authorizationResults.push(executed.authorization);
        await input.emit?.(
          createCancelledCallEvent({
            callId: call.callId,
            coordinates: input.coordinates,
            reason: SIGN_IN_REQUIRED,
            toolName: call.toolName,
          }),
        );
        continue;
      }
      turnState = settleCall(turnState, call.callId, executed.part);
      await input.emit?.(
        createActionResultEvent({
          presentation:
            executed.result.isError === true
              ? undefined
              : projectResultPresentation(
                  tools.get(call.toolName),
                  call.callId,
                  call.input,
                  executed.output,
                ),
          rejected: executed.denied,
          result: executed.result,
          ...input.coordinates,
        }),
      );
    }
  }
  return { authorizationResults, turnState };
}

async function runApprovedCall(input: {
  readonly abortSignal?: AbortSignal;
  readonly call: ParkedCall;
  readonly definition: HarnessToolDefinition | undefined;
  readonly messages: readonly ModelMessage[];
  readonly replayIdentity?: (toolName: string) => string | undefined;
}): Promise<{
  readonly authorization?: TypedToolResult<ToolSet>;
  /** The tool's own approval check refused the call when it came to run. */
  readonly denied?: true;
  readonly output?: unknown;
  readonly part: ToolResultPart;
  readonly result: RuntimeToolResultActionResult;
}> {
  const { call, definition } = input;
  const expected = call.approval?.replayIdentity;
  if (expected !== undefined && input.replayIdentity?.(call.toolName) !== expected) {
    return toolError(call, new Error(APPROVED_TOOL_CONNECTION_CHANGED_MESSAGE));
  }
  if (definition?.execute === undefined) {
    return toolError(call, new Error(APPROVED_TOOL_UNAVAILABLE_MESSAGE));
  }

  let ran: Awaited<ReturnType<typeof runApprovedToolCall>>;
  try {
    ran = await runApprovedToolCall({
      abortSignal: input.abortSignal,
      definition,
      input: call.input,
      messages: [...input.messages],
      toolCallId: call.callId,
    });
  } catch (error) {
    if (isTurnCancellation(error)) throw error;
    return toolError(call, error);
  }
  if (ran.denied) {
    return {
      denied: true,
      part: {
        output: { reason: TOOL_EXECUTION_DENIED_MESSAGE, type: "execution-denied" },
        toolCallId: call.callId,
        toolName: call.toolName,
        type: "tool-result",
      },
      result: toolError(call, new Error(TOOL_EXECUTION_DENIED_MESSAGE)).result,
    };
  }

  const toolResult: TypedToolResult<ToolSet> = {
    dynamic: true,
    input: call.input,
    output: ran.output,
    toolCallId: call.callId,
    toolName: call.toolName,
    type: "tool-result",
  };
  return {
    authorization: isInlineAuthorizationToolResult(toolResult) ? toolResult : undefined,
    output: ran.output,
    part: {
      output: ran.modelOutput,
      toolCallId: call.callId,
      toolName: call.toolName,
      type: "tool-result",
    },
    result: createRuntimeToolResultFromStepResult(toolResult),
  };
}

function toolError(
  call: ParkedCall,
  error: unknown,
): { readonly part: ToolResultPart; readonly result: RuntimeToolResultActionResult } {
  const toolErrorPart: TypedToolError<ToolSet> = {
    dynamic: true,
    error,
    input: call.input,
    toolCallId: call.callId,
    toolName: call.toolName,
    type: "tool-error",
  };
  return {
    part: createToolResultMessagePartFromToolError(toolErrorPart),
    result: createRuntimeToolResultFromToolError(toolErrorPart),
  };
}
