import type { ModelMessage, ToolSet, TypedToolResult } from "ai";

import { contextStorage } from "#context/container.js";
import {
  type AuthorizationChallenge,
  type AuthorizationSignal,
  isAuthorizationSignal,
  isPendingAuthorizationToolOutput,
} from "#harness/authorization.js";
import { readToolInterrupt } from "#harness/tool-interrupts.js";

/** Returns whether an inline tool result asks for a sign-in. */
export function isInlineAuthorizationToolResult(toolResult: TypedToolResult<ToolSet>): boolean {
  return (
    isPendingAuthorizationToolOutput(toolResult.output) ||
    readAuthorizationSignal(toolResult) !== undefined
  );
}

/** The sign-ins a step's tool calls asked for, and the calls that asked. */
export function findInlineAuthorizationSignals(
  toolResults: readonly TypedToolResult<ToolSet>[] | undefined,
):
  | {
      readonly callIds: readonly string[];
      readonly challenges: readonly AuthorizationChallenge[];
    }
  | undefined {
  const callIds: string[] = [];
  const challenges: AuthorizationChallenge[] = [];
  for (const toolResult of toolResults ?? []) {
    const signal = readAuthorizationSignal(toolResult);
    if (signal === undefined) continue;
    callIds.push(toolResult.toolCallId);
    challenges.push(...signal.challenges);
  }
  return callIds.length === 0 ? undefined : { callIds, challenges };
}

/**
 * History without these calls and their results, so the model calls them
 * again once signed in. An assistant message the calls leave with only text
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

function readAuthorizationSignal(
  toolResult: TypedToolResult<ToolSet>,
): AuthorizationSignal | undefined {
  const ctx = contextStorage.getStore();
  const stashed = ctx === undefined ? undefined : readToolInterrupt(ctx, toolResult.toolCallId);
  if (stashed !== undefined && isAuthorizationSignal(stashed)) return stashed;
  return isAuthorizationSignal(toolResult.output) ? toolResult.output : undefined;
}
