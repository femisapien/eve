import type { SessionAuthContext } from "#channel/types.js";
import type {
  WorkflowToolRunAnswer,
  WorkflowToolRunControlMessage,
} from "#execution/tools/workflow/messages.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import type { InputResponse } from "#shared/input.js";

/**
 * Sends the answers the session accepted to the asking run's control hook,
 * the same ordered inbox its commands use, so an answer the session accepted
 * before an interrupt or cancel reaches the body before them. `ctx.ask()`
 * sees who answered.
 */
export async function sendWorkflowAskAnswers(
  control: string,
  responses: readonly InputResponse[],
  auth: SessionAuthContext | null | undefined,
): Promise<void> {
  const responder =
    auth === null || auth === undefined
      ? undefined
      : {
          authenticator: auth.authenticator,
          principalId: auth.principalId,
          principalType: auth.principalType,
        };
  for (const { optionId, requestId, text } of responses) {
    const response: WorkflowToolRunAnswer =
      responder === undefined
        ? { optionId, status: "answered", text }
        : { optionId, responder, status: "answered", text };
    const answer: WorkflowToolRunControlMessage = { kind: "answer", requestId, response };
    await resumeHook(control, answer);
  }
}
