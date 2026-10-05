import type {
  InstrumentationAttemptScope,
  InstrumentationToolCallStartedEvent,
  InstrumentationToolCallTerminalEvent,
} from "#instrumentation/lifecycle.js";
import { resumeAction } from "#tracing/eve/agent-action-instrumentation.js";
import type { AgentActionTraceState } from "#tracing/eve/agent-trace-state.js";
import type { AgentTracing, AttemptOperation, ToolOperation } from "#tracing/lib/index.js";

const OPEN_TOOLS = 10000;

/** Tool executions finish in the process that ran them; a lost worker retries the step. */
export function createAgentToolInstrumentation(input: {
  readonly tracingFor: (agentName: string | undefined) => AgentTracing;
  readonly actionStateFor: (
    sessionId: string,
    turnId: string,
    callId: string,
  ) => Promise<AgentActionTraceState | undefined>;
  readonly attemptFor: (
    scope: InstrumentationAttemptScope,
  ) => Promise<{ attempt: AttemptOperation } | undefined>;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}) {
  const tools = new Map<string, { attemptId: string; handle: ToolOperation }>();

  async function onStarted(event: InstrumentationToolCallStartedEvent) {
    if (tools.has(event.idempotencyKey) || tools.size >= OPEN_TOOLS) return;
    const state = await input.actionStateFor(
      event.scope.sessionId,
      event.scope.turnId,
      event.callId,
    );
    const action = state === undefined ? undefined : await resumeAction(input.tracingFor, state);
    const handle =
      action === undefined
        ? await (
            await input.attemptFor(event.scope)
          )?.attempt.toolCall({
            callId: event.callId,
            name: event.toolName,
            arguments: input.recordInputs ? event.input : undefined,
          })
        : await action.toolExecution({
            arguments: input.recordInputs ? event.input : undefined,
          });
    if (handle !== undefined)
      tools.set(event.idempotencyKey, { attemptId: event.scope.attemptId, handle });
  }

  async function onTerminal(event: InstrumentationToolCallTerminalEvent) {
    const tool = tools.get(event.idempotencyKey);
    tools.delete(event.idempotencyKey);
    await tool?.handle.complete(
      event.type === "tool.call.failed" || event.output.type === "error"
        ? {
            outcome: "failed",
            failed: true,
            errorCode: "Error",
            error:
              event.type === "tool.call.failed"
                ? event.error
                : event.output.type === "error"
                  ? event.output.error
                  : undefined,
          }
        : { outcome: "completed", output: input.recordOutputs ? event.output.output : undefined },
    );
  }

  return {
    operationFor: (key: string) => tools.get(key)?.handle,
    /** Closes tools whose terminal event never arrived before their step ended. */
    async drain(attemptId: string, failure?: { error: unknown }) {
      for (const [key, tool] of tools)
        if (tool.attemptId === attemptId) {
          tools.delete(key);
          await tool.handle.complete({
            outcome: "abandoned",
            failed: failure !== undefined,
            error: failure?.error,
          });
        }
    },
    events: {
      "tool.call.started": onStarted,
      "tool.call.completed": onTerminal,
      "tool.call.failed": onTerminal,
    },
  };
}
