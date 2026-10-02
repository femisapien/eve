import type { ModelMessage } from "ai";

import type { InputRequest, InputResponse } from "#shared/input.js";
import { resolveTextToResponses } from "#channel/resolve-text.js";
import { hasTailApprovalResponse } from "#harness/current-messages.js";
import {
  answersEveryApproval,
  getApprovedTools,
  resolveOpenApprovals,
} from "#harness/hitl/approval-input-requests.js";
import type { RejectedActionBatch } from "#harness/hitl/approval-input-requests.js";
import type { OpenApprovals } from "#harness/open-approvals.js";
import {
  getDeferredStepInput,
  queueDeferredStepInput,
  readOpenApprovals,
} from "#harness/open-approvals.js";
import { compactStepInput, finishResolvedInput } from "#harness/hitl/pending-input-resolution.js";
import type {
  ResolvePendingInputResult,
  ResolvedStepInput,
} from "#harness/hitl/pending-input-resolution.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";

export { getApprovedTools };
export type { RejectedActionBatch };
export type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
export {
  consumeDeferredStepInput,
  hasOpenApprovals,
  openApprovalRequestIds,
  openApprovals,
} from "#harness/open-approvals.js";

/** Returns true when the step input carries user-facing turn input. */
export function hasStepInput(input?: StepInput): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.inputResponses?.length ?? 0) > 0;
}

/** Stored partial answers are not runnable work until they answer every open approval. */
export function hasRunnableDeferredStepInput(session: HarnessSession): boolean {
  const deferred = getDeferredStepInput(session);
  if (deferred === undefined) return false;
  if (
    deferred.message !== undefined ||
    (deferred.context?.length ?? 0) > 0 ||
    readClientContext(deferred) !== undefined ||
    deferred.outputSchema !== undefined ||
    (deferred.runtimeActionResults?.length ?? 0) > 0
  )
    return true;

  const responses = [
    ...(deferred.inputResponses ?? []),
    ...(deferred.attributedInputResponses ?? []).map(({ response }) => response),
  ];
  if (responses.length === 0) return false;
  const approvals = readOpenApprovals(session.state);
  return approvals !== undefined && answersEveryApproval(approvals, responses);
}

/** Returns the open approvals when this input answers them all and approves at least one. */
export function selectApprovalReplayBatch(
  session: HarnessSession,
  stepInput?: StepInput,
): OpenApprovals | undefined {
  const approvals = readOpenApprovals(session.state);
  if (approvals === undefined) return undefined;
  const resolved = resolveTextMessageInput(approvals, stepInput);
  const responses = canonicalizeInputResponses(resolved?.inputResponses ?? []);
  if (!answersEveryApproval(approvals, responses)) return undefined;
  return approvals.requests.some((request) =>
    responses.some(
      (response) => response.requestId === request.requestId && response.optionId === "approve",
    ),
  )
    ? approvals
    : undefined;
}

/**
 * Resolves pending input at the start of a harness step. Approvals preserve
 * AI SDK's tail-message requirement.
 */
export function resolvePendingInput(input: {
  readonly history?: readonly ModelMessage[];
  readonly resolveApprovalKey?: (request: InputRequest) => string | undefined;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}): ResolvePendingInputResult {
  const baseHistory = [...(input.history ?? input.session.history)];
  const approvals = readOpenApprovals(input.session.state);
  // Finish already-approved work before new approvals or a user message can
  // hide the approval response from the SDK.
  if (hasTailApprovalResponse(baseHistory)) {
    return finishResolvedInput({
      deferTurnInput: true,
      leftoverResponses: input.stepInput?.inputResponses ?? [],
      messages: baseHistory,
      resolvedStepInput: input.stepInput,
      session: input.session,
    });
  }
  if (approvals === undefined) {
    return { outcome: "continue", messages: baseHistory, session: input.session };
  }
  const resolvedStepInput = resolveTextMessageInput(approvals, input.stepInput);
  const responses = canonicalizeInputResponses(resolvedStepInput?.inputResponses ?? []);

  if (responses.length === 0 && resolvedStepInput?.message === undefined) {
    const deferredInput = compactStepInput(resolvedStepInput);
    const session =
      deferredInput.context !== undefined ||
      readClientContext(deferredInput) !== undefined ||
      deferredInput.outputSchema !== undefined
        ? queueDeferredStepInput(input.session, deferredInput)
        : input.session;
    return { outcome: "unresolved", messages: baseHistory, session };
  }

  return resolveOpenApprovals({
    approvals,
    baseHistory,
    resolveApprovalKey: input.resolveApprovalKey,
    resolvedStepInput,
    responses,
    session: input.session,
  });
}

function canonicalizeInputResponses(responses: readonly InputResponse[]): readonly InputResponse[] {
  const byRequestId = new Map<string, InputResponse>();
  for (const response of responses) byRequestId.set(response.requestId, response);
  return [...byRequestId.values()];
}

function resolveTextMessageInput(
  approvals: OpenApprovals,
  stepInput: StepInput | undefined,
): ResolvedStepInput | undefined {
  if (typeof stepInput?.message !== "string") return stepInput;

  const requestIds = new Set(approvals.requests.map((request) => request.requestId));
  if (stepInput.inputResponses?.some((response) => requestIds.has(response.requestId))) {
    return stepInput;
  }

  const responseAuthRequired = new Set(approvals.responseAuthRequiredRequestIds ?? []);
  const textRequests = approvals.requests.filter(
    (request) => !responseAuthRequired.has(request.requestId),
  );
  const responses = resolveTextToResponses(stepInput.message, textRequests);
  if (responses.length === 0) return stepInput;

  return compactStepInput({
    ...stepInput,
    inputResponses: [...(stepInput.inputResponses ?? []), ...responses],
    messageConsumed: true,
    message: undefined,
  });
}
