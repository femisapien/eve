import type {
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  type DurableSession,
  readDurableSession,
} from "#execution/durable-session-store.js";
import {
  withSessionEventEmitter,
  type PublishedSessionEvents,
  type SessionEventTarget,
} from "#execution/publish-session-events.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import {
  emitTurnEpilogue,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import { emitProxiedInputRequest } from "#subagents/hitl-proxy.js";
import { upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import type { AnswerHookRoute } from "#harness/proxy-input-requests.js";
import type { HarnessSession } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

type SubagentEventHookPayload =
  | SubagentAuthorizationEventHookPayload
  | SubagentInputRequestHookPayload;

/** Proxies one child event through its parent channel across a durable step boundary. */
export async function runProxySubagentEventStep(
  input: SessionEventTarget & {
    readonly answerHook?: AnswerHookRoute;
    readonly hookPayload: SubagentEventHookPayload;
  },
): Promise<PublishedSessionEvents> {
  "use step";

  const durableSession = readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);

  return emitProxiedSubagentEvent({
    answerHook: input.answerHook,
    ctx,
    durableSession,
    hookPayload: input.hookPayload,
    sessionWritable: input.sessionWritable,
  });
}

/** Relays one child event through the parent session's channel. */
export async function emitProxiedSubagentEvent(input: {
  readonly answerHook?: AnswerHookRoute;
  readonly ctx: ContextContainer;
  readonly durableSession: DurableSession;
  readonly hookPayload: SubagentEventHookPayload;
  readonly sessionWritable: WritableStream<Uint8Array>;
}): Promise<PublishedSessionEvents> {
  const { ctx, hookPayload } = input;
  const relayed = await withSessionEventEmitter(
    {
      ctx,
      durableSession: input.durableSession,
      origin: "relayed",
      sessionWritable: input.sessionWritable,
    },
    async (emit, session) => {
      if (hookPayload.kind === "subagent-authorization-event") {
        await emit(hookPayload.event);
        return {
          result: undefined,
          session: await closeStandaloneAuthorizationEvent({
            emit,
            eventType: hookPayload.event.type,
            session,
          }),
        };
      }

      const proxyResult = await emitProxiedInputRequest({ emit, hookPayload, session });
      return { result: proxyResult.entries, session: proxyResult.session };
    },
  );

  let scopedSession = relayed.session;
  if (relayed.result !== undefined && hookPayload.kind === "subagent-input-request") {
    const answerHook = input.answerHook;
    scopedSession = upsertProxyInputRequests({
      entries:
        answerHook === undefined
          ? relayed.result
          : relayed.result.map(([requestId, route]) => [requestId, { ...route, answerHook }]),
      forChildContinuationToken: hookPayload.childContinuationToken,
      session: scopedSession,
    });
  }

  const nextSession = reconcileSessionContinuationToken(ctx, scopedSession);

  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session: nextSession }),
  };
}

async function closeStandaloneAuthorizationEvent(input: {
  readonly emit: (event: UnstampedMessageStreamEvent) => Promise<void>;
  readonly eventType: SubagentAuthorizationEventHookPayload["event"]["type"];
  readonly session: HarnessSession;
}): Promise<HarnessSession> {
  if (
    input.eventType !== "authorization.required" &&
    input.eventType !== "authorization.completed"
  ) {
    return input.session;
  }

  const state = getHarnessEmissionState(input.session.state);
  const nextState = await emitTurnEpilogue(input.emit, state);
  return setHarnessEmissionState(input.session, nextState);
}
