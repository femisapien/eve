import type { DeliverHookPayload } from "#channel/types.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import type { Input } from "#harness/hitl/index.js";

import {
  commitSessionStep,
  forwardRelayedAnswers,
  mapWaitingInputResponses,
  type ForwardedRelayedAnswers,
} from "./session.js";

// The durable steps that apply human input around a turn. Only steps live
// here: a `"use step"` module cannot export plain helpers into a workflow body.

/** Forwards the answers a delivery carries for relayed requests; see `forwardRelayedAnswers`. */
export async function forwardRelayedAnswersStep(
  input: SessionStepState & { readonly delivery: DeliverHookPayload },
): Promise<WithSessionStateDelta<ForwardedRelayedAnswers>> {
  "use step";
  return await withSessionStateDelta(input, forwardRelayedAnswers);
}

/**
 * Withdraws what a run relayed that nobody can answer anymore: everything,
 * once the run ended, or one `ctx.ask()` question the run asks to withdraw.
 */
export async function withdrawRelayedRequestsStep(
  input: SessionStepState & {
    readonly intake: Extract<Input, { readonly type: "run.ended" | "relayed.withdrawn" }>;
  },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, async (target) => {
    const { ending: _none, ...published } = await commitSessionStep(target, [target.intake]);
    return published;
  });
}

/** Maps a delivery's channel-specific answers for a waiting turn; see `mapWaitingInputResponses`. */
export async function mapWaitingInputResponsesStep(
  input: SessionStepState & {
    readonly delivery: DeliverHookPayload;
    readonly requestIds: readonly string[];
  },
): Promise<WithSessionStateDelta<{ readonly delivery: DeliverHookPayload | undefined }>> {
  "use step";
  return await withSessionStateDelta(input, async () => await mapWaitingInputResponses(input));
}
