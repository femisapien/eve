import type { DeliverHookPayload } from "#channel/types.js";
import { forwardRelayedAnswersStep } from "#execution/relayed-answers-step.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { HumanInput } from "#harness/human-input/index.js";

/**
 * Forwards a delivery's answers to the relayed requests they answer, and
 * returns what is left for this session: `undefined` when nothing, or
 * `cancel-turn` for a relayed budget Stop. A session relaying nothing, the
 * common case, skips the durable step.
 *
 * Lives apart from the step so the session workflow can share it: a
 * `"use step"` module cannot export plain helpers into a workflow body.
 */
export async function forwardRelayedAnswers(
  delivery: DeliverHookPayload,
  cursor: SessionStateCursor,
): Promise<
  | { readonly kind: "cancel-turn" }
  | { readonly kind: "continue"; readonly remainder: DeliverHookPayload | undefined }
> {
  if (HumanInput.read(cursor.sessionState.snapshot.session.state).relayedRequestIds().size === 0) {
    return { kind: "continue", remainder: delivery };
  }
  const forwarded = await cursor.advance((state) =>
    forwardRelayedAnswersStep({ delivery, ...state }),
  );
  return forwarded.kind === "cancel-turn"
    ? { kind: "cancel-turn" }
    : { kind: "continue", remainder: forwarded.remainder };
}
