import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import {
  restoreSessionStep,
  type PublishedSessionEvents,
  type RestoredSessionStep,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { relaySubagentEvent } from "#harness/human-input/effects/index.js";

type SubagentEventHookPayload =
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload;

/** Proxies one child event through its parent channel across a durable step boundary. */
export async function runProxySubagentEventStep(
  input: SessionStepState & RelayedBy & { readonly hookPayload: SubagentEventHookPayload },
): Promise<SessionStateTransition> {
  "use step";

  return await withSessionStateDelta(input, async (target) =>
    emitProxiedSubagentEvent({
      ...(await restoreSessionStep(target)),
      control: target.control,
      runId: target.runId,
      hookPayload: target.hookPayload,
    }),
  );
}

/** The workflow tool run that relayed a question, and its control hook when the question is its own `ctx.ask()`. */
interface RelayedBy {
  readonly control?: string;
  readonly runId?: string;
}

/**
 * Relays one child event through the parent session, as human input: a
 * child's question waits for the answer this session routes back, and a
 * child's sign-in waits for the callback the child completes it on.
 */
export async function emitProxiedSubagentEvent(
  input: RestoredSessionStep & RelayedBy & { readonly hookPayload: SubagentEventHookPayload },
): Promise<PublishedSessionEvents> {
  return await relaySubagentEvent(input);
}
