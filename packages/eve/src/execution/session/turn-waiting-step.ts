import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { createTurnWaitingEvent } from "#protocol/message.js";
import { storedProjection, turnPosition } from "#harness/session-machine/view.js";

/** Publishes `turn.waiting` for the open turn the session workflow just parked. */
export async function publishTurnWaitingStep(
  target: SessionStepState,
): Promise<SessionStateTransition> {
  "use step";

  return await withSessionStateDelta(target, async (input) => {
    const { sequence, turnId } = turnPosition(storedProjection(input.serializedContext));
    if (turnId === "")
      return { serializedContext: input.serializedContext, sessionState: input.sessionState };
    return await publishSessionEvents(input, [createTurnWaitingEvent({ sequence, turnId })]);
  });
}
