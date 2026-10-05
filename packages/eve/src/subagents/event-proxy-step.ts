import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import {
  publishFromSessionStep,
  restoreSessionStep,
  type PublishedSessionEvents,
  type RestoredSessionStep,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import { SessionHost } from "#harness/human-input/effects/index.js";
import { HumanInput, type InputOf } from "#harness/human-input/index.js";

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
  const { hookPayload } = input;
  const host = new SessionHost();
  const committed = await HumanInput.commit(host, input.durableSession, relayedInterrupt(input));
  const { published } = await publishFromSessionStep(
    { ...input, durableSession: committed.session },
    {
      origin: "relayed",
      inputSource:
        hookPayload.kind === "subagent-input-request"
          ? JSON.stringify([hookPayload.childContinuationToken, hookPayload.inputSource ?? null])
          : undefined,
      async publish(emit) {
        for (const event of host.relayed) await emit(event);
      },
    },
  );
  return published;
}

function relayedInterrupt(
  input: RelayedBy & { readonly hookPayload: SubagentEventHookPayload },
): InputOf<"parked"> {
  const { control, hookPayload, runId } = input;
  if (hookPayload.kind === "subagent-authorization-event") {
    return {
      event: hookPayload.event,
      runId: runId ?? hookPayload.childSessionId,
      type: "relayed.authorization",
    };
  }
  const { event } = hookPayload;
  return {
    at: { sequence: event.sequence, stepIndex: event.stepIndex, turnId: event.turnId },
    requests: event.requests,
    route: {
      childContinuationToken: hookPayload.childContinuationToken,
      // The address names the child only when it is the child's own inbox.
      ...(hookPayload.childSessionInbox?.sessionId === hookPayload.childSessionId && {
        childSessionInbox: hookPayload.childSessionInbox,
      }),
      ...(hookPayload.remote !== undefined && { remote: hookPayload.remote }),
      ...(hookPayload.inputSource !== undefined && { inputSource: hookPayload.inputSource }),
      ...(runId !== undefined && { runId }),
      ...(control !== undefined && { control }),
    },
    ...(event.taskId !== undefined && { taskId: event.taskId }),
    type: "relayed.requested",
  };
}
