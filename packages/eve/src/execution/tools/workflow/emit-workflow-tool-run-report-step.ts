import {
  publishSessionEvents,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { createActionPartialEvent } from "#protocol/message.js";
import type { JsonValue } from "#shared/json.js";

/** Publishes a workflow tool run's `ctx.report()` update as `action.partial`. */
export async function emitWorkflowToolRunReportStep(
  input: SessionStepState & {
    readonly from: WorkflowToolRunRef;
    readonly update: JsonValue;
  },
): Promise<PublishedSessionEvents> {
  "use step";

  const event = createActionPartialEvent({
    result: createRuntimeToolResultFromValue({
      callId: input.from.callId,
      output: input.update,
      toolName: input.from.toolName,
    }),
    sequence: input.from.sequence,
    stepIndex: input.from.stepIndex,
    turnId: input.from.turnId,
  });
  return await publishSessionEvents(input, [event]);
}
