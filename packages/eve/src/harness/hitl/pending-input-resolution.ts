import type { ModelMessage } from "ai";

import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import type { InputResponse } from "#shared/input.js";
import type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
import type { InputRequestEvent, OpenApprovals } from "#harness/open-approvals.js";
import { queueInput } from "#harness/open-approvals.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";

export type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];

/** Action results from resolved approvals, attributed to their originating turn. */
export interface ResolvedInputActionBatch {
  readonly event: InputRequestEvent;
  readonly results: readonly RuntimeToolResultActionResult[];
}

export type ResolvedStepInput = StepInput & { readonly messageConsumed?: boolean };

export type InputDomainResolverInput = {
  readonly approvals: OpenApprovals;
  readonly baseHistory: ModelMessage[];
  readonly resolvedStepInput: ResolvedStepInput | undefined;
  readonly responses: readonly InputResponse[];
  readonly session: HarnessSession;
};

export type ResolvePendingInputResult = {
  readonly consumedMessage?: boolean;
  readonly deferredContext?: boolean;
  readonly deferredMessage?: boolean;
  readonly outcome: "resolved" | "continue" | "unresolved";
  readonly messages: ModelMessage[];
  readonly rejectedActions?: readonly ResolvedInputActionBatch[];
  readonly resolvedInputs?: readonly ResolvedInputBatch[];
  readonly session: HarnessSession;
};

export function responsesForApprovals(
  responses: readonly InputResponse[],
  approvals: OpenApprovals,
): readonly InputResponse[] {
  return responses.filter((response) =>
    approvals.requests.some((request) => request.requestId === response.requestId),
  );
}

export function finishResolvedInput(input: {
  readonly deferTurnInput: boolean;
  readonly leftoverResponses: readonly InputResponse[];
  readonly messages: ModelMessage[];
  readonly rejectedActions?: readonly ResolvedInputActionBatch[];
  readonly resolvedInputs?: readonly ResolvedInputBatch[];
  readonly resolvedStepInput: ResolvedStepInput | undefined;
  readonly session: HarnessSession;
}): ResolvePendingInputResult {
  // Deferred turn input replays on a later step, after the work it waits behind.
  const deferredInput: {
    context?: StepInput["context"];
    inputResponses?: StepInput["inputResponses"];
    message?: StepInput["message"];
  } = {};
  let clientContext: readonly string[] | undefined;
  if (input.leftoverResponses.length > 0) {
    deferredInput.inputResponses = input.leftoverResponses;
  }
  if (input.deferTurnInput) {
    if ((input.resolvedStepInput?.context?.length ?? 0) > 0) {
      deferredInput.context = input.resolvedStepInput?.context;
    }
    const resolvedClientContext = readClientContext(input.resolvedStepInput);
    if ((resolvedClientContext?.length ?? 0) > 0) {
      clientContext = resolvedClientContext;
    }
    if (input.resolvedStepInput?.message !== undefined) {
      deferredInput.message = input.resolvedStepInput.message;
    }
  }
  attachClientContext(deferredInput, clientContext);

  if (Object.keys(deferredInput).length > 0) {
    return {
      consumedMessage: input.resolvedStepInput?.messageConsumed,
      deferredContext:
        deferredInput.context === undefined && readClientContext(deferredInput) === undefined
          ? undefined
          : true,
      deferredMessage: deferredInput.message === undefined ? undefined : true,
      outcome: "resolved",
      messages: input.messages,
      rejectedActions: input.rejectedActions,
      resolvedInputs: input.resolvedInputs,
      session: queueInput(input.session, deferredInput),
    };
  }

  return {
    consumedMessage: input.resolvedStepInput?.messageConsumed,
    outcome: "resolved",
    messages: input.messages,
    rejectedActions: input.rejectedActions,
    resolvedInputs: input.resolvedInputs,
    session: input.session,
  };
}

export function compactStepInput(input: ResolvedStepInput | undefined): ResolvedStepInput {
  if (input === undefined) {
    return {};
  }

  const result: {
    context?: StepInput["context"];
    inputResponses?: StepInput["inputResponses"];
    message?: StepInput["message"];
    messageConsumed?: boolean;
    outputSchema?: StepInput["outputSchema"];
  } = {};

  if ((input.context?.length ?? 0) > 0) result.context = input.context;
  if ((input.inputResponses?.length ?? 0) > 0) result.inputResponses = input.inputResponses;
  if (input.message !== undefined) result.message = input.message;
  if (input.messageConsumed === true) result.messageConsumed = true;
  if (input.outputSchema !== undefined) result.outputSchema = input.outputSchema;

  return attachClientContext(result, readClientContext(input));
}
