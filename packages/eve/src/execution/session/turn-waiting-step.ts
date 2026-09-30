import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import { type SessionStateTransition } from "#execution/session/state-delta.js";
import { withSessionStateDelta } from "#execution/session/with-session-state-delta.js";
import { createTurnWaitingEvent } from "#protocol/message.js";

/** Publishes `turn.waiting` for the open turn the session workflow just parked. */
export async function publishTurnWaitingStep(
  target: SessionStepState,
): Promise<SessionStateTransition> {
  "use step";

  return await withSessionStateDelta(target, async (input) => {
    const { sequence, turnId } = input.sessionState.turn;
    return await publishSessionEvents(input, [createTurnWaitingEvent({ sequence, turnId })]);
  });
}
