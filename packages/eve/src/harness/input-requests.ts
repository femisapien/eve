import type { ModelMessage } from "ai";

import type { InputResponse } from "#shared/input.js";
import { resolveTextToResponses } from "#channel/resolve-text.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import {
  answersEveryApproval,
  resolveOpenApprovals,
  type ApprovalResolutionTools,
} from "#harness/hitl/approval-input-requests.js";
import type { RejectedActionBatch } from "#harness/hitl/approval-input-requests.js";
import type { OpenApprovals } from "#harness/open-approvals.js";
import { getQueuedInput, queueInput, readOpenApprovals } from "#harness/open-approvals.js";
import { compactStepInput } from "#harness/hitl/pending-input-resolution.js";
import type {
  ResolvePendingInputResult,
  ResolvedStepInput,
} from "#harness/hitl/pending-input-resolution.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import { readClientContext } from "#internal/client-context.js";
import { readTurnInputRequests } from "#harness/open-input-requests.js";

export type { RejectedActionBatch };
export type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
export {
  consumeQueuedInput,
  hasOpenApprovals,
  openApprovalRequestIds,
} from "#harness/open-approvals.js";

/** Returns true when the step input carries user-facing turn input. */
export function hasStepInput(input?: StepInput): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.inputResponses?.length ?? 0) > 0;
}

/** Queued partial answers are not runnable work until they answer every open approval. */
export function hasRunnableQueuedInput(session: HarnessSession): boolean {
  const queued = getQueuedInput(session);
  if (queued === undefined) return false;
  if (
    queued.message !== undefined ||
    (queued.context?.length ?? 0) > 0 ||
    readClientContext(queued) !== undefined ||
    queued.outputSchema !== undefined ||
    (queued.runtimeActionResults?.length ?? 0) > 0
  )
    return true;

  const responses = [
    ...(queued.inputResponses ?? []),
    ...(queued.attributedInputResponses ?? []).map(({ response }) => response),
  ];
  if (responses.length === 0) return false;
  const approvals = readOpenApprovals(session.state);
  return approvals !== undefined && answersEveryApproval(approvals, responses);
}

/** Returns the open approvals when this input answers them all and approves at least one. */
export function selectApprovingStep(
  session: HarnessSession,
  stepInput?: StepInput,
): OpenApprovals | undefined {
  const approvals = readOpenApprovals(session.state);
  if (approvals === undefined) return undefined;
  const resolved = resolveTextMessageInput(approvals, stepInput, session.state);
  const responses = canonicalizeInputResponses(resolved?.inputResponses ?? []);
  if (!answersEveryApproval(approvals, responses)) return undefined;
  return approvals.requests.some(
    (request) =>
      isApprovalRequest(request) &&
      responses.some(
        (response) => response.requestId === request.requestId && response.optionId === "approve",
      ),
  )
    ? approvals
    : undefined;
}

/** Resolves the open approvals at the start of a harness step. */
export function resolvePendingInput(
  input: ApprovalResolutionTools & {
    readonly history?: readonly ModelMessage[];
    readonly session: HarnessSession;
    readonly stepInput?: StepInput;
  },
): ResolvePendingInputResult {
  const baseHistory = [...(input.history ?? input.session.history)];
  const approvals = readOpenApprovals(input.session.state);
  if (approvals === undefined) {
    return { outcome: "continue", messages: baseHistory, session: input.session };
  }
  const resolvedStepInput = resolveTextMessageInput(
    approvals,
    input.stepInput,
    input.session.state,
  );
  const responses = canonicalizeInputResponses(resolvedStepInput?.inputResponses ?? []);

  if (responses.length === 0 && resolvedStepInput?.message === undefined) {
    const queued = compactStepInput(resolvedStepInput);
    const session =
      queued.context !== undefined ||
      readClientContext(queued) !== undefined ||
      queued.outputSchema !== undefined
        ? queueInput(input.session, queued)
        : input.session;
    return { outcome: "unresolved", messages: baseHistory, session };
  }

  return resolveOpenApprovals({
    approvalKey: input.approvalKey,
    approvals,
    baseHistory,
    resolvedStepInput,
    responses,
    runsInRuntime: input.runsInRuntime,
    session: input.session,
  });
}

function canonicalizeInputResponses(responses: readonly InputResponse[]): readonly InputResponse[] {
  const byRequestId = new Map<string, InputResponse>();
  for (const response of responses) byRequestId.set(response.requestId, response);
  return [...byRequestId.values()];
}

/**
 * Plain text answers the waiting step's approvals, except those a response
 * policy must decide. The budget question wins when it is open too. Text that
 * answers only some approvals still counts: those are answered, and the rest
 * keep waiting.
 */
function resolveTextMessageInput(
  approvals: OpenApprovals,
  stepInput: StepInput | undefined,
  state: HarnessSession["state"],
): ResolvedStepInput | undefined {
  if (typeof stepInput?.message !== "string") return stepInput;

  const requestIds = new Set(approvals.requests.map((request) => request.requestId));
  if (stepInput.inputResponses?.some((response) => requestIds.has(response.requestId))) {
    return stepInput;
  }
  const budget = [...readTurnInputRequests(state).values()].some(
    (entry) => entry.request.kind === "session-limit",
  );
  if (budget) return stepInput;

  const policyDecides = new Set(approvals.responseAuthRequiredRequestIds ?? []);
  const responses = resolveTextToResponses(
    stepInput.message,
    approvals.requests.filter((request) => !policyDecides.has(request.requestId)),
  );
  if (responses.length === 0) return stepInput;

  return compactStepInput({
    ...stepInput,
    inputResponses: [...(stepInput.inputResponses ?? []), ...responses],
    messageConsumed: true,
    message: undefined,
  });
}
