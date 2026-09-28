import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import type { WorkflowAskRoute } from "#harness/proxy-input-requests.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { InputResponse } from "#shared/input.js";

/**
 * Sends the answers the session accepted to the asking run's control hook,
 * the same ordered inbox its commands use, so an answer the session accepted
 * before an interrupt or cancel reaches the body before them.
 */
export async function sendWorkflowAskAnswers(
  route: WorkflowAskRoute,
  responses: readonly InputResponse[] | undefined,
): Promise<void> {
  for (const response of responses ?? []) {
    const answer: WorkflowToolRunControlMessage = {
      kind: "answer",
      requestId: response.requestId,
      response: { optionId: response.optionId, status: "answered", text: response.text },
    };
    await resumeHook(route.control, answer);
  }
}
