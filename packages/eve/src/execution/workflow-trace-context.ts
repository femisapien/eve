import type { TurnState } from "#harness/turn-state.js";
import type { ExecutionInstrumentation } from "#instrumentation/runtime.js";
import type { RuntimeTraceContext } from "#protocol/message.js";

/** Prepares native tracing for workflow-owned preambles emitted outside the tool loop. */
export async function prepareWorkflowPreambleTrace(input: {
  readonly turnState: TurnState;
  readonly instrumentation: ExecutionInstrumentation | undefined;
}): Promise<RuntimeTraceContext | undefined> {
  return await input.instrumentation?.preparePreamble({
    sequence: input.turnState.sequence,
    sessionStarted: input.turnState.started,
    turnId: `turn_${input.turnState.sequence}`,
  });
}
