import { operationConversationId } from "#tracing/conversation-context.js";
import type { InstrumentationModelCallCompletedEvent } from "#instrumentation/lifecycle.js";
import { AGENT_TRACE_SCHEMA_VERSION } from "#tracing/agent-span-contract.js";

export function traceSessionIdOf(scope: {
  readonly traceSessionId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
}): string {
  return scope.traceSessionId ?? scope.rootSessionId ?? scope.sessionId;
}

export function agentTraceIdentityAttributes(input: {
  readonly rootSessionId: string;
  readonly sessionId: string;
  readonly traceSessionId: string;
}): Record<string, string | number> {
  const conversationId = operationConversationId(input);
  const attributes: Record<string, string | number> = {
    "agent.run.id": input.sessionId,
    "agent.trace.schema.version": AGENT_TRACE_SCHEMA_VERSION,
    "gen_ai.conversation.id": conversationId,
  };
  if (process.env.VERCEL_ENV !== undefined) {
    attributes["vercel.session_id"] = input.traceSessionId;
  }
  return attributes;
}

export function modelCallCompletedAttributes(
  event: InstrumentationModelCallCompletedEvent,
  recordOutputs: boolean,
): Record<string, string | boolean> {
  const attributes: Record<string, string | boolean> = {
    "agent.trace.content.output": recordOutputs && event.content !== undefined,
  };
  if (event.gateway?.generationId !== undefined) {
    attributes["gen_ai.generation.id"] = event.gateway.generationId;
  }
  if (event.gateway?.transcriptsEnabled === true) {
    attributes["vercel.ai_gateway.transcript.enabled"] = true;
  }
  return attributes;
}
