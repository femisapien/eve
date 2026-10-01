import { buildAdapterContext } from "#channel/adapter-context.js";
import { callAdapterEventHandler, type ChannelAdapterContext } from "#channel/adapter.js";
import { type ContextContainer, contextStorage } from "#context/container.js";
import { dispatchStreamEventHooks } from "#context/hook-lifecycle.js";
import {
  AnswerDeliveryIdsKey,
  ParentSessionKey,
  PendingBoundaryDeliveryIdsKey,
  SessionProjectionKey,
  TurnDeliveryIdsKey,
} from "#context/keys.js";
import { withContextScope } from "#context/run-step.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import * as activityCohort from "#execution/activity-cohort.js";
import { setChannelContext } from "#execution/channel-context.js";
import { forwardSessionInput } from "#execution/forward-session-input.js";
import {
  createDurableSessionState,
  readDurableSession,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import { observeSessionActivity } from "#execution/session-activity-projection.js";
import { hydrateDurableSession } from "#execution/session.js";
import { activeTurnId, turnPosition } from "#harness/session-machine/view.js";
import { dropClosedRecords } from "#harness/session-machine/commit.js";
import type { HandleEventFn, HarnessSession } from "#harness/types.js";
import { bindSessionInstrumentation } from "#instrumentation/runtime.js";
import { createLogger } from "#internal/logging.js";
import {
  createSessionWaitingEvent,
  encodeMessageStreamEvent,
  stampMessageStreamEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import {
  foldSession,
  initialSessionProjection,
  openInputs,
  openSignIns,
  pruneSessionProjection,
  type SessionProjection,
  type SessionTurn,
} from "#protocol/session-projection.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.publish-session-events");

/**
 * Whose event a session publishes. Every event reaches the channel adapter, the
 * session stream, and stream-event hooks. The session's own events also reach
 * its instrumentation and activity and carry its turn's delivery ids.
 *
 * A relayed event belongs to an exchange this session carries for a child
 * session or a workflow run: the question or sign-in it raised, the turn
 * boundary that question causes here, and the `input.resolved` for the answer
 * this session routes back. This session's instrumentation and activity never
 * track that pending input, so no event of the exchange reaches them; the
 * child records its side as its own.
 */
export type SessionEventOrigin = "own" | "relayed";

/** The session a step publishes to: its stream and the state it starts from. */
export interface SessionStepState {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

/** The context and session state a publication leaves behind. */
export interface PublishedSessionEvents {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Publishes a session step's own events, such as a workflow tool's
 * `action.partial`, exactly as a turn publishes its events. Call from a step
 * and adopt the result: hooks run in the session's context and may change it.
 */
export async function publishSessionEvents(
  target: SessionStepState,
  events: readonly UnstampedMessageStreamEvent[],
): Promise<PublishedSessionEvents> {
  return await publishFromStep(target, "own", events);
}

/** Publishes events of an exchange this session relays; see {@link SessionEventOrigin}. */
export async function relaySessionEvents(
  target: SessionStepState,
  events: readonly UnstampedMessageStreamEvent[],
  answers?: ForwardedAnswers,
): Promise<PublishedSessionEvents> {
  return await publishFromStep(target, "relayed", events, answers);
}

/**
 * Answers this session forwarded to a child session or a workflow run. Their events carry the
 * answers' deliveries, and their responses complete here: at once between turns, or at the open
 * turn's next boundary.
 */
export interface ForwardedAnswers {
  readonly deliveryIds: readonly string[];
}

async function publishFromStep(
  target: SessionStepState,
  origin: SessionEventOrigin,
  events: readonly UnstampedMessageStreamEvent[],
  answers?: ForwardedAnswers,
): Promise<PublishedSessionEvents> {
  const forwarded = answers?.deliveryIds ?? [];
  if (events.length === 0 && forwarded.length === 0) {
    return { serializedContext: target.serializedContext, sessionState: target.sessionState };
  }
  const ctx = await deserializeContext(target.serializedContext);
  if (forwarded.length > 0) {
    ctx.setVirtualContext(AnswerDeliveryIdsKey, forwarded);
    acceptDeliveries(ctx, forwarded);
    if (readSessionProjection(ctx).activeTurnId === undefined) {
      events = [...events, createSessionWaitingEvent()];
    }
  }
  const { session } = await withSessionEventEmitter(
    {
      ctx,
      durableSession: readDurableSession(target.sessionState),
      origin,
      sessionWritable: target.sessionWritable,
    },
    async (emit, scopedSession) => {
      for (const event of events) await emit(event);
      return { result: undefined, session: scopedSession };
    },
  );
  return {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({
      session: reconcileSessionContinuationToken(ctx, session),
    }),
  };
}

/**
 * Runs `emitEvents` in the session's context scope with an emit that publishes
 * each event with the given origin. `ctx` is updated in place; the returned
 * session is the one `emitEvents` returns after the scope commits.
 */
export async function withSessionEventEmitter<T>(
  input: {
    readonly ctx: ContextContainer;
    readonly durableSession: DurableSession;
    readonly origin: SessionEventOrigin;
    readonly sessionWritable: WritableStream<Uint8Array>;
    readonly inputSource?: string;
  },
  emitEvents: (
    emit: HandleEventFn,
    session: HarnessSession,
  ) => Promise<{ readonly result: T; readonly session: HarnessSession }>,
): Promise<{ readonly result: T; readonly session: HarnessSession }> {
  const { ctx } = input;
  const bundle = ctx.require(BundleKey);
  const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
  const session = hydrateDurableSession({
    compactionOverrides: { thresholdPercent: effectiveAgent.thresholdPercent },
    durable: input.durableSession,
    turnAgent: effectiveAgent.turnAgent,
  });
  const instrumentation =
    input.origin === "own"
      ? bindSessionInstrumentation({
          agentName: effectiveAgent.turnAgent.id,
          ctx,
          rootSessionId: session.rootSessionId ?? session.sessionId,
          sessionId: session.sessionId,
        })
      : undefined;

  const sink = openSessionEventStream({
    ctx,
    origin: input.origin,
    sessionId: session.sessionId,
    sessionWritable: input.sessionWritable,
    inputSource: input.inputSource,
  });
  try {
    return await withContextScope(ctx, session, async (enrichedSession) => {
      const publish: HandleEventFn = async (event) => {
        const stamped = await sink.emit(event);
        // Only turn-step events can cancel the running turn; see turn-event-handler.ts.
        await dispatchStreamEventHooks({
          cancelTurn: undefined,
          ctx,
          registry: bundle.hookRegistry,
          event: stamped,
        });
      };
      const emit =
        instrumentation?.createHandleEvent({
          handleEvent: publish,
          turnId: activeTurnId(turnPosition(readSessionProjection(ctx))),
        }) ?? publish;
      const emitted = await emitEvents(emit, enrichedSession);
      return {
        ...emitted,
        session: dropClosedRecords(emitted.session, readSessionProjection(ctx)),
      };
    });
  } finally {
    await instrumentation?.flush();
    sink.release();
  }
}

/** A session's stream held by one step. */
export interface SessionEventSink {
  readonly adapterCtx: ChannelAdapterContext;
  /**
   * Routes one event through the channel adapter, then stamps and writes it.
   * Stream-event hooks and instrumentation belong to the caller.
   */
  emit(event: UnstampedMessageStreamEvent): Promise<MessageStreamEvent>;
  /** Closes the session stream; only a terminal `done` step does this. */
  close(): Promise<void>;
  /** Releases the writer lock so the next step can acquire it. Safe after `close()`. */
  release(): void;
}

/**
 * The turn step's sink for its own events. A turn composes the rest of the
 * publication itself: its tool loop binds instrumentation to each model call,
 * and an event's hooks run after that event's memory lifecycle.
 */
export function createSessionEventSink(input: {
  readonly ctx: ContextContainer;
  readonly sessionId: string;
  readonly sessionWritable: WritableStream<Uint8Array>;
}): SessionEventSink {
  return openSessionEventStream({ ...input, origin: "own" });
}

function openSessionEventStream(input: {
  readonly ctx: ContextContainer;
  readonly origin: SessionEventOrigin;
  readonly sessionId: string;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly inputSource?: string;
}): SessionEventSink {
  const { ctx, origin } = input;
  const adapter = ctx.require(ChannelKey);
  const adapterCtx = buildAdapterContext(adapter, ctx);
  const writer = input.sessionWritable.getWriter();

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    writer.releaseLock();
  };
  return {
    adapterCtx,
    async emit(event) {
      if (origin === "own") activityCohort.updateActivityState(ctx, event);
      const forwarded = await forwardSessionInput(ctx, event, input.inputSource);
      const routed = forwarded
        ? event
        : await callAdapterEventHandler(
            adapter,
            event,
            input.inputSource === undefined
              ? adapterCtx
              : { ...adapterCtx, inputSource: input.inputSource },
          );
      setChannelContext(ctx, { ...adapter, state: { ...adapterCtx.state } });
      const stamped = stampMessageStreamEvent(
        withProcessedDeliveries(ctx, routed),
        origin === "own" ? ctx.get(TurnDeliveryIdsKey) : undefined,
        ctx.get(AnswerDeliveryIdsKey),
      );
      await writer.write(encodeMessageStreamEvent(stamped));
      recordPublishedEvent(ctx, stamped);
      if (origin === "own") {
        void observeSessionActivity({ ctx, event: stamped, sessionId: input.sessionId });
      }
      return stamped;
    },
    close: async () => {
      await writer.close();
      release();
    },
    release,
  };
}

/**
 * Folds a published event into the session's stored projection. Every event the session
 * publishes passes here once, after it reached the stream, so the projection is exactly the fold
 * of the session's stream. A boundary prunes what closed.
 */
function recordPublishedEvent(ctx: ContextContainer, event: MessageStreamEvent): void {
  const folded = foldSession(ctx.get(SessionProjectionKey) ?? initialSessionProjection(), event);
  ctx.set(
    SessionProjectionKey,
    event.type === "session.waiting" ? pruneSessionProjection(folded) : folded,
  );
}

/**
 * Lists on a boundary the accepted deliveries whose response it completes. A turn that waits on
 * its tasks hasn't answered yet, and neither has a session waiting on a sign-in callback the
 * last turn asked for, since the callback resumes that work; otherwise every pending delivery is
 * complete.
 */
function withProcessedDeliveries(
  ctx: ContextContainer,
  event: UnstampedMessageStreamEvent,
): UnstampedMessageStreamEvent {
  if (event.type !== "session.waiting" && event.type !== "turn.waiting") return event;
  const projection = readSessionProjection(ctx);
  const holds =
    event.type === "turn.waiting"
      ? openInputs(projection).length === 0 && openSignIns(projection).length === 0
      : awaitsSignInCallback(projection);
  const pending = ctx.get(PendingBoundaryDeliveryIdsKey) ?? [];
  if (!holds) ctx.delete(PendingBoundaryDeliveryIdsKey);
  return {
    ...event,
    data: { ...event.data, processedDeliveryIds: holds ? [] : pending },
  } as UnstampedMessageStreamEvent;
}

/** The last turn asked for a sign-in whose callback resumes its work. */
function awaitsSignInCallback(projection: SessionProjection): boolean {
  const lastTurn = Object.values(projection.turns).reduce<SessionTurn | undefined>(
    (latest, turn) => (latest === undefined || turn.sequence > latest.sequence ? turn : latest),
    undefined,
  );
  return openSignIns(projection).some(
    (attempt) => attempt.awaitsCallback === true && attempt.turnId === lastTurn?.turnId,
  );
}

/**
 * Whether a step that ends between turns still owes accepted deliveries a boundary: it
 * consumed them, an ignored message or an answer that left the session waiting, without
 * publishing one. Every accepted delivery reaches a boundary that lists it.
 */
export function deliveriesAwaitBoundary(ctx: ContextContainer): boolean {
  const projection = readSessionProjection(ctx);
  return (
    (ctx.get(PendingBoundaryDeliveryIdsKey)?.length ?? 0) > 0 &&
    projection.activeTurnId === undefined &&
    projection.ended !== true &&
    !awaitsSignInCallback(projection)
  );
}

/** Adds accepted deliveries to those the next completing boundary lists. */
export function acceptDeliveries(ctx: ContextContainer, deliveryIds: readonly string[]): void {
  if (deliveryIds.length === 0) return;
  const pending = ctx.get(PendingBoundaryDeliveryIdsKey) ?? [];
  ctx.set(PendingBoundaryDeliveryIdsKey, [...new Set([...pending, ...deliveryIds])]);
}

/** The session's projection as of the last event it published. */
export function readSessionProjection(ctx: ContextContainer): SessionProjection {
  return ctx.get(SessionProjectionKey) ?? initialSessionProjection();
}

type TerminalSessionEvent = Extract<
  UnstampedMessageStreamEvent,
  { type: "session.completed" | "session.failed" }
>;

/**
 * Publishes a terminal `session.completed` or `session.failed` from outside a
 * turn as the session's own event, through its channel adapter and
 * instrumentation. Stream-event hooks do not run: the ending session may not
 * restore, and no turn scope remains for authored code. Never throws.
 *
 * When the context cannot be restored, the event is only stamped and written so
 * the stream still ends: the one degraded write of a session event.
 */
export async function publishTerminalSessionEvent(input: {
  readonly errorId?: string;
  readonly event: TerminalSessionEvent;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionWritable: WritableStream<Uint8Array>;
  /** The turn the event ends, for instrumentation. */
  readonly turnId?: string;
}): Promise<void> {
  const sessionId = (input.serializedContext["eve.sessionId"] as string | undefined) ?? "";
  const fields = { errorId: input.errorId, sessionId };
  const { type } = input.event;

  let ctx: ContextContainer;
  let sink: SessionEventSink;
  try {
    ctx = await deserializeContext(input.serializedContext);
    sink = createSessionEventSink({ ctx, sessionId, sessionWritable: input.sessionWritable });
  } catch (error) {
    log.error(`failed to restore context for terminal ${type} event`, { ...fields, error });
    await writeUnroutedSessionEvent(input.sessionWritable, input.event).catch((writeError) =>
      log.error(`failed to write terminal ${type} event`, { ...fields, error: writeError }),
    );
    return;
  }

  const publish: HandleEventFn = async (event) => {
    await sink.emit(event);
  };
  let instrumentation: ReturnType<typeof bindSessionInstrumentation>;
  try {
    instrumentation = bindSessionInstrumentation({
      agentName: ctx.require(BundleKey).turnAgent.id,
      ctx,
      rootSessionId: ctx.get(ParentSessionKey)?.rootSessionId ?? sessionId,
      sessionId,
    });
  } catch (error) {
    log.error(`failed to bind instrumentation for terminal ${type} event`, { ...fields, error });
  }
  const emit =
    instrumentation?.createHandleEvent({ handleEvent: publish, turnId: input.turnId }) ?? publish;
  try {
    await contextStorage.run(ctx, () => emit(input.event));
  } catch (error) {
    log.error(`failed to publish terminal ${type} event`, { ...fields, error });
  } finally {
    sink.release();
    try {
      await instrumentation?.flush();
    } catch (error) {
      log.error(`failed to flush instrumentation after terminal ${type} event`, {
        ...fields,
        error,
      });
    }
  }
}

async function writeUnroutedSessionEvent(
  sessionWritable: WritableStream<Uint8Array>,
  event: UnstampedMessageStreamEvent,
): Promise<void> {
  const writer = sessionWritable.getWriter();
  try {
    await writer.write(encodeMessageStreamEvent(stampMessageStreamEvent(event)));
  } finally {
    writer.releaseLock();
  }
}
