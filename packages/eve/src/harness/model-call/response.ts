import type { ModelMessage, ToolSet, TypedToolResult } from "ai";

import type { HarnessStepResult } from "#harness/step-hooks.js";

type StepResponseMessage = HarnessStepResult["response"]["messages"][number];

export function withAccumulatedResponseMessages(input: {
  readonly invalidInputToolCallIds?: ReadonlySet<string>;
  readonly responseMessages: readonly StepResponseMessage[];
  readonly stepResult: HarnessStepResult;
  readonly toolResults?: readonly TypedToolResult<ToolSet>[];
}): HarnessStepResult {
  const { stepResult } = input;

  /*
   * AI SDK `StepResult` fields are prototype getters, so spreading the
   * instance drops them. Materialize each field while replacing the final
   * step's messages with the SDK's accumulated response, which also contains
   * approval-resume results created before the model step.
   */
  return {
    content: stepResult.content,
    finishReason: stepResult.finishReason,
    ...(input.invalidInputToolCallIds === undefined
      ? {}
      : { invalidInputToolCallIds: input.invalidInputToolCallIds }),
    providerMetadata: stepResult.providerMetadata,
    response: {
      ...stepResult.response,
      messages: [...input.responseMessages],
    },
    text: stepResult.text,
    toolCalls: stepResult.toolCalls,
    toolResults: input.toolResults === undefined ? stepResult.toolResults : [...input.toolResults],
    usage: stepResult.usage,
  };
}

/** True when provider history still owes a result for any assistant tool call. */
export function hasUnansweredToolCall(messages: readonly ModelMessage[]): boolean {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (typeof part !== "object" || part === null) continue;
      if (part.type === "tool-call") callIds.add(part.toolCallId);
      if (part.type === "tool-result") resultIds.add(part.toolCallId);
    }
  }

  for (const callId of callIds) {
    if (!resultIds.has(callId)) return true;
  }
  return false;
}
