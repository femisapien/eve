import type { ModelMessage } from "ai";

import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import {
  buildResolvedInputBatch,
  resolveApprovalOutcome,
  TOOL_EXECUTION_DENIED_MESSAGE,
} from "#harness/input-request-resolution.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import type { OpenApprovals } from "#harness/open-approvals.js";
import { queueInput } from "#harness/open-approvals.js";
import {
  compactStepInput,
  finishResolvedInput,
  responsesForApprovals,
} from "#harness/hitl/pending-input-resolution.js";
import type {
  InputDomainResolverInput,
  ResolvedInputActionBatch,
  ResolvePendingInputResult,
} from "#harness/hitl/pending-input-resolution.js";
import {
  answeredCallIds,
  readApprovalStep,
  readTurnState,
  replaceSuspendedStep,
  withResult,
  writeTurnState,
  type SuspendedStep,
} from "#harness/turn-state.js";

const TOOL_EXECUTION_DENIED_CODE = "TOOL_EXECUTION_DENIED";

export type RejectedActionBatch = ResolvedInputActionBatch;

/** How the step's tools treat the approved calls. */
export interface ApprovalResolutionTools {
  /** The `once()` key an approval grants; the tool's name when it has none. */
  readonly approvalKey?: (request: InputRequest) => string | undefined;
  /** Whether the runtime, not eve, runs an approved call. */
  readonly runsInRuntime?: (request: InputRequest) => boolean;
}

/** Returns true when `responses` answer every open approval. */
export function answersEveryApproval(
  approvals: OpenApprovals,
  responses: readonly InputResponse[],
): boolean {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return approvals.requests.every((request) => responseIds.has(request.requestId));
}

/**
 * Resolves the open approvals once every one is answered. A partial answer
 * queues and the turn stays held; a message instead of an answer steers the
 * held turn past its approvals. Approved calls stay in the step without a
 * result, for the caller to run; responses for requests the step doesn't hold
 * queue for the next step.
 */
export function resolveOpenApprovals(
  input: InputDomainResolverInput & ApprovalResolutionTools,
): ResolvePendingInputResult {
  if (!answersEveryApproval(input.approvals, input.responses)) {
    if (input.resolvedStepInput?.message === undefined) {
      return {
        outcome: "unresolved",
        messages: [...input.baseHistory],
        session: queueInput(input.session, compactStepInput(input.resolvedStepInput)),
      };
    }
    // A message instead of an answer steers the held turn past its approvals.
    // Requests already answered, as in a partial approval, keep that answer;
    // the rest report `ignored`.
    return resolveApprovals(input, responsesForApprovals(input.responses, input.approvals));
  }
  return resolveApprovals(input, input.responses);
}

function resolveApprovals(
  input: InputDomainResolverInput & ApprovalResolutionTools,
  responses: readonly InputResponse[],
): ResolvePendingInputResult {
  const step = readApprovalStep(input.session.state);
  if (step === undefined) {
    throw new Error("eve internal error: open approvals have no suspended step.");
  }
  const decided = decideApprovals(step, responses, input.approvalKey);
  const resolvedIds = new Set(step.requests.map((request) => request.requestId));
  const turn = readTurnState(input.session.state);
  const session = replaceSuspendedStep(
    writeTurnState(input.session, {
      ...turn,
      grants: [...new Set([...turn.grants, ...decided.grants])],
    }),
    step,
    { ...step, messages: decided.messages, requests: [] },
  );
  const resolved = buildResolvedInputBatch(input.approvals, responses);
  return finishResolvedInput({
    // Input waits behind approved workflow calls, so the model reads it after their results.
    deferTurnInput: decided.approved.some((request) => input.runsInRuntime?.(request) === true),
    leftoverResponses: input.responses.filter((response) => !resolvedIds.has(response.requestId)),
    messages: [...input.baseHistory],
    rejectedActions: decided.rejected === undefined ? undefined : [decided.rejected],
    resolvedInputs: resolved === undefined ? [] : [resolved],
    resolvedStepInput: input.resolvedStepInput,
    session,
  });
}

/**
 * Each request's decision: a denied call gets its denial as a result in the
 * step, and an approved one grants its key.
 */
function decideApprovals(
  step: SuspendedStep,
  responses: readonly InputResponse[],
  approvalKey: ApprovalResolutionTools["approvalKey"],
): {
  readonly approved: readonly InputRequest[];
  readonly grants: readonly string[];
  readonly messages: readonly ModelMessage[];
  readonly rejected?: RejectedActionBatch;
} {
  const byId = new Map(responses.map((response) => [response.requestId, response]));
  const approved: InputRequest[] = [];
  const grants: string[] = [];
  const results: RuntimeToolResultActionResult[] = [];
  let messages = step.messages;
  for (const request of step.requests) {
    if (!isApprovalRequest(request)) continue;
    const {
      approved: isApproved,
      reason,
      status,
    } = resolveApprovalOutcome(byId.get(request.requestId));
    if (isApproved) {
      approved.push(request);
      grants.push(approvalKey?.(request) ?? request.action.toolName);
      continue;
    }
    messages = withResult(messages, {
      output: { reason, type: "execution-denied" },
      toolCallId: request.action.callId,
      toolName: request.action.toolName,
      type: "tool-result",
    });
    results.push({
      callId: request.action.callId,
      isError: true,
      kind: "tool-result",
      output: {
        approval: { requestId: request.requestId, status },
        code: TOOL_EXECUTION_DENIED_CODE,
        message: reason ?? TOOL_EXECUTION_DENIED_MESSAGE,
        tool: { result: "not_run" },
      },
      toolName: request.action.toolName,
    });
  }
  return {
    approved,
    grants,
    messages,
    rejected: results.length > 0 ? { event: step.event, results } : undefined,
  };
}

const CANCELLED_APPROVAL_REASON = "Cancelled before anyone answered.";

/** What the model reads for a call its turn's cancellation stopped before the call settled. */
export const CANCELLED_CALL_RESULT = "The turn was cancelled before this call finished.";

/**
 * The suspended step's response when its turn is cancelled, each call without
 * a result answered: a call awaiting approval as denied, any other as stopped.
 * The model keeps the calls it made, so it sees that the work started and
 * stopped rather than a request left unanswered.
 */
export function cancelledStepTranscript(step: SuspendedStep): readonly ModelMessage[] {
  const answered = answeredCallIds(step.messages);
  const awaitingApproval = new Set(
    step.requests.flatMap((request) => (isApprovalRequest(request) ? [request.action.callId] : [])),
  );
  let messages = step.messages;
  for (const message of step.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "tool-call" || part.providerExecuted === true) continue;
      if (answered.has(part.toolCallId)) continue;
      messages = withResult(messages, {
        output: awaitingApproval.has(part.toolCallId)
          ? { reason: CANCELLED_APPROVAL_REASON, type: "execution-denied" }
          : { type: "text", value: CANCELLED_CALL_RESULT },
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        type: "tool-result",
      });
    }
  }
  return messages;
}
