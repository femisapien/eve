import type { SessionAuthContext } from "#channel/types.js";
import type { ReceivedAuthorizationCallback } from "#harness/authorization.js";
import type { StepInput } from "#harness/types.js";
import { readAnswerText } from "#internal/input-text.js";

import type { InputOf } from "./host.js";

/**
 * What arrived for a turn's step, as the inputs human input reads, in the
 * order it reads them. Answers always count; a message counts only while the
 * turn waits on a person, since otherwise it is the turn's next input.
 */
export function arrivalsOf(input: {
  readonly callbacks: readonly ReceivedAuthorizationCallback[];
  readonly waiting: boolean;
  readonly now: number;
  /** Who the turn runs as, the sender of answers that name no one else. */
  readonly sender: SessionAuthContext | null;
  readonly stepInput: StepInput | undefined;
}): InputOf<"pre-step">[] {
  const { now, sender, stepInput } = input;
  // Time goes first, so an answer that expired never runs its policy.
  const inputs: InputOf<"pre-step">[] = [{ now, type: "time" }];
  for (const { attemptId, callback, connectionName } of input.callbacks) {
    inputs.push(
      callback === undefined
        ? { attemptId, connectionName, outcome: "failed", type: "authorization.completed" }
        : {
            attemptId,
            callback,
            connectionName,
            outcome: "authorized",
            type: "authorization.completed",
          },
    );
  }
  const responses = stepInput?.inputResponses ?? [];
  if (responses.length > 0)
    inputs.push({ now, responder: sender, responses, type: "input.answered" });
  for (const attributed of stepInput?.attributedInputResponses ?? []) {
    inputs.push({
      now,
      responder: attributed.auth,
      responses: [attributed.response],
      type: "input.answered",
    });
  }
  if (stepInput?.message !== undefined && input.waiting) {
    inputs.push({
      sender: stepInput.messageAuth ?? sender,
      text: readAnswerText(stepInput) ?? "",
      type: "message.received",
    });
  }
  return inputs;
}
