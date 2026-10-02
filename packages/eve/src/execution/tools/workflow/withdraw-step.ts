import {
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { relayHumanInputEvents } from "#execution/human-input-events.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { HumanInput, type Intake } from "#harness/human-input/index.js";

/**
 * Withdraws what a run relayed that nobody can answer anymore: everything,
 * once the run ended, or one `ctx.ask()` question the run asks to withdraw.
 */
export async function withdrawRelayedRequestsStep(
  input: SessionStepState & {
    readonly intake: Extract<Intake, { readonly type: "run.ended" | "withdraw.requested" }>;
  },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, async (target) => {
    const session = readDurableSession(target.sessionState);
    const transition = HumanInput.read(session.state).intake(target.intake);
    return await relayHumanInputEvents(
      {
        ...target,
        sessionState: replaceDurableSessionSnapshot({
          session: { ...session, state: transition.humanInput.write(session.state) },
          state: target.sessionState,
        }),
      },
      transition.events,
    );
  });
}
