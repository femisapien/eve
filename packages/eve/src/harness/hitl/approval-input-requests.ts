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
import {
  closeApprovals,
  queueDeferredStepInput,
  readOpenApprovals,
} from "#harness/open-approvals.js";
import {
  appendResolvedBatchTranscript,
  compactStepInput,
  finishResolvedInput,
  responsesForApprovals,
} from "#harness/hitl/pending-input-resolution.js";
import type {
  InputDomainResolverInput,
  ResolvedInputActionBatch,
  ResolvePendingInputResult,
  ToolResponsePart,
} from "#harness/hitl/pending-input-resolution.js";
import type { HarnessSession } from "#harness/types.js";

const APPROVED_TOOLS_KEY = "eve.runtime.hitl.approvedTools";
const TOOL_EXECUTION_DENIED_CODE = "TOOL_EXECUTION_DENIED";
type ToolApprovalInputRequest = InputRequest & { readonly kind: "tool-approval" };

export type RejectedActionBatch = ResolvedInputActionBatch;

/** Returns true when `responses` answer every open approval. */
export function answersEveryApproval(
  approvals: OpenApprovals,
  responses: readonly InputResponse[],
): boolean {
  const responseIds = new Set(responses.map((response) => response.requestId));
  return approvals.requests.every((request) => responseIds.has(request.requestId));
}

/**
 * Resolves the open approvals once every one is answered. Responses for other
 * request IDs are dropped.
 */
export function resolveOpenApprovals(
  input: InputDomainResolverInput & {
    readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  },
): ResolvePendingInputResult {
  if (!answersEveryApproval(input.approvals, input.responses)) {
    if (input.resolvedStepInput?.message === undefined) {
      return {
        outcome: "unresolved",
        messages: [...input.baseHistory],
        session: queueDeferredStepInput(input.session, compactStepInput(input.resolvedStepInput)),
      };
    }
    // A message instead of an answer steers the held turn past its approvals.
    return ignoreOpenApprovals(input);
  }

  const approval = resolveApprovalBatch({
    batch: input.approvals,
    messages: [...input.baseHistory],
    resolveApprovalKey: input.resolveApprovalKey,
    responses: input.responses,
    session: input.session,
  });
  const resolved = buildResolvedInputBatch(input.approvals, input.responses);

  return finishResolvedInput({
    deferTurnInput: true,
    leftoverResponses: [],
    messages: approval.messages,
    rejectedActions: approval.rejectedActions,
    resolvedInputs: resolved === undefined ? [] : [resolved],
    resolvedStepInput: input.resolvedStepInput,
    session: closeApprovals(approval.session),
  });
}

/**
 * Resolves the open approvals when the person steered the held turn with a
 * message instead of answering them all. Requests they already answered, as in
 * a partial approval, keep that answer; the rest report `ignored`.
 */
function ignoreOpenApprovals(
  input: InputDomainResolverInput & {
    readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  },
): ResolvePendingInputResult {
  const answers = responsesForApprovals(input.responses, input.approvals);
  const approval = resolveApprovalBatch({
    batch: input.approvals,
    messages: [...input.baseHistory],
    resolveApprovalKey: input.resolveApprovalKey,
    responses: answers,
    session: input.session,
  });
  const resolved = buildResolvedInputBatch(input.approvals, answers);
  return finishResolvedInput({
    // Calls that will not run already have their results, so the message joins
    // this step. An approved call runs through AI SDK, which needs its approval
    // response last, so the message replays after it.
    deferTurnInput: answers.some((answer) => resolveApprovalOutcome(answer).approved),
    leftoverResponses: [],
    messages: approval.messages,
    rejectedActions: approval.rejectedActions,
    resolvedInputs: resolved === undefined ? [] : [resolved],
    resolvedStepInput: input.resolvedStepInput,
    session: closeApprovals(approval.session),
  });
}

const CANCELLED_APPROVAL_REASON = "Cancelled before anyone answered.";

/**
 * Withdraws the open tool approvals when their turn is cancelled. Each held
 * call goes into history with a not-run result, so no call is left without one.
 */
/**
 * The not-run results the open approvals' waiting calls get when their turn is
 * cancelled, as one tool message; `undefined` when no approval is open.
 */
export function cancelledApprovalResults(state: HarnessSession["state"]): ModelMessage | undefined {
  const approvals = readOpenApprovals(state);
  if (approvals === undefined) return undefined;
  const messages: ModelMessage[] = [];
  appendResolvedBatchTranscript(
    messages,
    buildApprovalBatchToolResponseParts(approvals, [], CANCELLED_APPROVAL_REASON),
  );
  return messages[0];
}

/** Returns the approval keys recorded when earlier approvals resolved. */
export function getApprovedTools(session: HarnessSession): ReadonlySet<string> {
  const value = session.state?.[APPROVED_TOOLS_KEY];
  return Array.isArray(value) ? new Set(value as string[]) : new Set();
}

function resolveApprovalBatch(input: {
  readonly batch: OpenApprovals;
  readonly messages: ModelMessage[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
}): ResolvedApprovalBatch {
  const session = recordApprovedTools({
    pendingBatch: input.batch,
    resolveApprovalKey: input.resolveApprovalKey,
    responses: input.responses,
    session: input.session,
  });
  const toolParts = buildApprovalBatchToolResponseParts(input.batch, input.responses);
  appendResolvedBatchTranscript(input.messages, toolParts);
  const rejected = buildRejectedActionBatch(input.batch, input.responses);

  return {
    messages: input.messages,
    rejectedActions: rejected === undefined ? undefined : [rejected],
    session,
  };
}

type ResolvedApprovalBatch = {
  readonly messages: ModelMessage[];
  readonly rejectedActions?: readonly RejectedActionBatch[];
  readonly session: HarnessSession;
};

function recordApprovedTools(input: {
  readonly pendingBatch: OpenApprovals;
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
}): HarnessSession {
  const approvedIds = new Set(
    input.responses.filter((response) => response.optionId === "approve").map((r) => r.requestId),
  );
  const newKeys = input.pendingBatch.requests
    .filter((request) => isApprovalRequest(request) && approvedIds.has(request.requestId))
    .map((request) => input.resolveApprovalKey?.(request) ?? request.action.toolName);

  if (newKeys.length === 0) return input.session;

  const state = { ...input.session.state };
  state[APPROVED_TOOLS_KEY] = [...new Set([...getApprovedTools(input.session), ...newKeys])];
  return { ...input.session, state };
}

function buildRejectedActionBatch(
  batch: OpenApprovals,
  responses: readonly InputResponse[],
): RejectedActionBatch | undefined {
  if (batch.event === undefined) return undefined;

  const responseMap = new Map(responses.map((response) => [response.requestId, response]));
  const results: RuntimeToolResultActionResult[] = [];
  for (const request of batch.requests) {
    if (!isApprovalRequest(request)) continue;

    const { approved, reason, status } = resolveApprovalOutcome(responseMap.get(request.requestId));
    if (approved) continue;

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

  return results.length > 0 ? { event: batch.event, results } : undefined;
}

function buildApprovalBatchToolResponseParts(
  batch: OpenApprovals,
  responses: readonly InputResponse[],
  /** Why an unanswered request did not run, when not because the user moved on. */
  unansweredReason?: string,
): ToolResponsePart[] {
  const responseMap = new Map(responses.map((response) => [response.requestId, response]));
  const parts: ToolResponsePart[] = [];
  for (const request of batch.requests) {
    const response = responseMap.get(request.requestId);
    switch (request.kind) {
      case "tool-approval":
        parts.push(
          ...buildApprovalToolResponseParts(
            request as ToolApprovalInputRequest,
            response,
            unansweredReason,
          ),
        );
        break;
      case "question":
      case "session-limit":
        throw new TypeError(`Open tool approvals cannot contain a "${request.kind}" request.`);
      default: {
        const unhandled: never = request.kind;
        throw new TypeError(`Unhandled pending input request kind: ${String(unhandled)}`);
      }
    }
  }
  return parts;
}

function buildApprovalToolResponseParts(
  request: ToolApprovalInputRequest,
  response: InputResponse | undefined,
  unansweredReason: string | undefined,
): ToolResponsePart[] {
  const outcome = resolveApprovalOutcome(response);
  const approved = outcome.approved;
  const reason = response === undefined ? (unansweredReason ?? outcome.reason) : outcome.reason;
  const parts: ToolResponsePart[] = [
    { approvalId: request.requestId, approved, reason, type: "tool-approval-response" },
  ];
  // Persist an explicit denial result because AI SDK strips historical
  // approval responses during provider prompt conversion.
  if (!approved) {
    parts.push({
      output: { type: "execution-denied", reason },
      toolCallId: request.action.callId,
      toolName: request.action.toolName,
      type: "tool-result",
    });
  }
  return parts;
}
