import { readDurableSession } from "#execution/durable-session-store.js";
import { publishSessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { hold } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";

/** Publishes `turn.waiting` for the open turn the session workflow just parked. */
export async function publishTurnWaitingStep(
  target: SessionStepState,
): Promise<SessionStateTransition> {
  "use step";

  return await withSessionStateDelta(target, async (input) => {
    const { state } = readDurableSession(input.sessionState);
    const { events } = hold(sessionView(storedProjection(state), state));
    if (events.length === 0)
      return { serializedContext: input.serializedContext, sessionState: input.sessionState };
    return await publishSessionEvents(input, events);
  });
}
