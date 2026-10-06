import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { relaySubagentEvent } from "#harness/hitl/host/index.js";

/**
 * Relays one child event through the parent session across a durable step
 * boundary; see `relaySubagentEvent`. `runId` names the workflow tool run that
 * relayed a question, and `control` its hook when the question is its own
 * `ctx.ask()`.
 */
export async function runProxySubagentEventStep(
  input: SessionStepState & {
    readonly control?: string;
    readonly runId?: string;
    readonly hookPayload: SubagentAuthorizationEventHookPayload | SubagentInputRequestHookPayload;
  },
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, relaySubagentEvent);
}
