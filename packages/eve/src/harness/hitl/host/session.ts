import type { ModelMessage } from "ai";

import type {
  DeliverHookPayload,
  DeliverPayload,
  SubagentAuthorizationEventHookPayload,
  SubagentInputRequestHookPayload,
} from "#channel/types.js";
import { TurnDeliveryIdsKey } from "#context/keys.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import {
  publishFromSessionStep,
  publishSessionEvents,
  relaySessionEvents,
  restoreSessionStep,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import {
  HumanInput,
  type Ending,
  type EventOrigin,
  type HostEventOf,
  type HumanInputHost,
  type InputOf,
  type RelayRoute,
} from "#harness/hitl/index.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import { inputTextKey, readAnswerText } from "#internal/input-text.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";

import { forwardAnswers, withdrawQuestion, type Forward } from "./relay-asker.js";
import { deliverChannelInputResponses } from "./channel-answer-id.js";

/**
 * Carries out, in a session step around the turn, what human input reports:
 * a cancel, a request a child or run relays, or an answer to one. It collects
 * what to publish and add to history, which the step does once it holds the
 * session that `commit` left.
 */
export class SessionHost implements HumanInputHost<DurableSession, "parked"> {
  readonly phase = "parked";
  readonly own: UnstampedMessageStreamEvent[] = [];
  readonly relayed: UnstampedMessageStreamEvent[] = [];
  readonly history: ModelMessage[] = [];
  /** The answers to forward to whoever asked, since the last `take`. */
  forwarded: Extract<HostEventOf<"parked">, { readonly type: "forwardAnswer" }>[] = [];
  /** A message answered relayed requests, since the last `take`. */
  messageAnswered = false;

  async publish(event: UnstampedMessageStreamEvent, origin: EventOrigin): Promise<void> {
    (origin === "relayed" ? this.relayed : this.own).push(event);
  }

  /** A turn waiting on a child's request reports `turn.waiting` at the step it parked at. */
  waitingAt(session: DurableSession) {
    const turn = getHarnessEmissionState(session.state);
    return { sequence: turn.sequence, turnId: turn.turnId, usage: getSessionUsage(session) };
  }

  async carry(event: HostEventOf<"parked">, session: DurableSession): Promise<DurableSession> {
    switch (event.type) {
      case "appendHistory":
        this.history.push(event.message);
        return session;
      case "withdrawQuestion":
        await withdrawQuestion(event.control, event.requestId);
        return session;
      case "forwardAnswer":
        this.forwarded.push(event);
        return session;
      case "consumeMessage":
        this.messageAnswered = true;
        return session;
    }
  }

  /** What one commit forwarded and whether its message answered, resetting both for the next. */
  take(): {
    readonly forwarded: readonly Extract<
      HostEventOf<"parked">,
      { readonly type: "forwardAnswer" }
    >[];
    readonly messageAnswered: boolean;
  } {
    const taken = { forwarded: this.forwarded, messageAnswered: this.messageAnswered };
    this.forwarded = [];
    this.messageAnswered = false;
    return taken;
  }
}

/**
 * Commits what happened to a session step's human input, then publishes what
 * it reported: relayed events as relayed, its own as its own. `inputSource`
 * names where a relayed input batch came from.
 */
export async function commitSessionStep(
  target: SessionStepState,
  inputs: readonly InputOf<"parked">[],
  options: { readonly inputSource?: string } = {},
): Promise<PublishedSessionEvents & { readonly ending?: Ending }> {
  const host = new SessionHost();
  let session = readDurableSession(target.sessionState);
  let ending: Ending | undefined;
  for (const input of inputs) {
    const committed = await HumanInput.commit(host, session, input);
    session = committed.session;
    ending ??= committed.ending;
  }
  const committed = {
    ...target,
    sessionState: replaceDurableSessionSnapshot({ session, state: target.sessionState }),
  };
  const relayed = await publishCollected(committed, "relayed", host.relayed, options.inputSource);
  const own = await publishCollected({ ...committed, ...relayed }, "own", host.own);
  return ending === undefined ? own : { ...own, ending };
}

async function publishCollected(
  target: SessionStepState,
  origin: EventOrigin,
  events: readonly UnstampedMessageStreamEvent[],
  inputSource?: string,
): Promise<PublishedSessionEvents> {
  if (events.length === 0) {
    return { serializedContext: target.serializedContext, sessionState: target.sessionState };
  }
  if (inputSource === undefined) {
    return origin === "relayed"
      ? await relaySessionEvents(target, events)
      : await publishSessionEvents(target, events);
  }
  const { published } = await publishFromSessionStep(await restoreSessionStep(target), {
    inputSource,
    origin,
    async publish(emit) {
      for (const event of events) await emit(event);
    },
  });
  return published;
}

export type ForwardedRelayedAnswers =
  | {
      readonly kind: "cancel-turn";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "continue";
      /** What the delivery leaves for this session's turn, or `undefined` when nothing. */
      readonly remainder: DeliverHookPayload | undefined;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };

/** Payload keys that describe the message, dropped with it when it answers a question. */
const MESSAGE_KEYS: ReadonlySet<string> = new Set(["context", "message", inputTextKey]);

/**
 * Reports a delivery to human input, payload by payload, forwards the answers
 * it hands to relayed requests to whoever asked, and relays the events it
 * reports once they are on their way. Returns what is left for this session's
 * turn, or `cancel-turn` when an answer cancelled it.
 */
export async function forwardRelayedAnswers(
  input: SessionStepState & { readonly delivery: DeliverHookPayload },
): Promise<ForwardedRelayedAnswers> {
  let session = readDurableSession(input.sessionState);
  const relayed = HumanInput.read(session.state).relayedRequestIds();
  const { delivery, serializedContext } = await deliverChannelInputResponses({
    ...input,
    routable: (response) => relayed.has(response.requestId),
  });
  const delegated = hasDelegatedSessionContext(serializedContext) || delivery.caller !== undefined;

  const host = new SessionHost();
  const forwards = new Map<string, Forward>();
  const kept: [index: number, payload: DeliverPayload][] = [];
  // Deliveries whose message answered a question: like a steering message,
  // the answer joins the open turn, so the turn's later events carry its ids.
  const answerDeliveryIds: string[] = [];
  let cancelled = false;
  for (const [index, payload] of delivery.payloads.entries()) {
    const text = readAnswerText(payload);
    const committed = await HumanInput.commit(host, session, {
      responses: payload.inputResponses ?? [],
      ...(text !== undefined && { message: { delegated, text } }),
      type: "delivery.received",
    });
    session = committed.session;
    cancelled ||= committed.ending !== undefined;
    const { forwarded: answered, messageAnswered } = host.take();
    if (messageAnswered) {
      for (const metadata of delivery.deliveryMetadata ?? []) {
        if (metadata.payloadIndex === index) answerDeliveryIds.push(metadata.deliveryId);
      }
    }
    const forwarded = new Set<string>();
    let first: Forward | undefined;
    for (const event of answered) {
      const key = routeKey(event.route);
      const forward = forwards.get(key) ?? { metadata: [], payloads: [], route: event.route };
      forwards.set(key, forward);
      forward.payloads.push({ inputResponses: event.responses });
      for (const response of event.responses) forwarded.add(response.requestId);
      first ??= forward;
    }
    const remainder = remainderOf(payload, forwarded, messageAnswered);
    if (remainder !== undefined) {
      kept.push([index, remainder]);
      continue;
    }
    // A payload answered in full belongs to its first asker, which acknowledges it.
    for (const metadata of delivery.deliveryMetadata ?? []) {
      if (metadata.payloadIndex === index && first !== undefined) {
        first.metadata.push({ ...metadata, payloadIndex: first.payloads.length - 1 });
      }
    }
  }

  for (const forward of forwards.values()) {
    await forwardAnswers(forward, delivery, serializedContext);
  }

  const target = {
    serializedContext: joinTurnDeliveryIds(serializedContext, answerDeliveryIds),
    sessionState: replaceDurableSessionSnapshot({ session, state: input.sessionState }),
    sessionWritable: input.sessionWritable,
  };
  // The session's own events first (the message that answered), then what it relays.
  const own = await publishCollected(target, "own", host.own);
  const context = await relaySessionEvents({ ...target, ...own }, host.relayed);
  if (cancelled) return { ...context, kind: "cancel-turn" };
  const metadata = kept.flatMap(([index], payloadIndex) =>
    (delivery.deliveryMetadata ?? [])
      .filter((entry) => entry.payloadIndex === index)
      .map((entry) => ({ ...entry, payloadIndex })),
  );
  const remainder =
    kept.length === 0
      ? undefined
      : {
          ...delivery,
          deliveryMetadata: metadata.length === 0 ? undefined : metadata,
          payloads: kept.map(([, payload]) => payload),
        };
  return { ...context, kind: "continue", remainder };
}

function joinTurnDeliveryIds(
  serializedContext: Record<string, unknown>,
  deliveryIds: readonly string[],
): Record<string, unknown> {
  if (deliveryIds.length === 0) return serializedContext;
  const current =
    (serializedContext[TurnDeliveryIdsKey.name] as readonly string[] | undefined) ?? [];
  return {
    ...serializedContext,
    [TurnDeliveryIdsKey.name]: [...new Set([...current, ...deliveryIds])],
  };
}

/**
 * Maps the channel-specific answers of a delivery to the requests the turn
 * waits on, so the turn can tell they answer it. Returns the mapped delivery,
 * or `undefined` when the channel maps none of them to one of `requestIds`.
 */
export async function mapWaitingInputResponses(
  input: SessionStepState & {
    readonly delivery: DeliverHookPayload;
    readonly requestIds: readonly string[];
  },
): Promise<{
  readonly delivery: DeliverHookPayload | undefined;
  readonly serializedContext?: Record<string, unknown>;
}> {
  const requestIds = new Set(input.requestIds);
  const mapped = await deliverChannelInputResponses({
    ...input,
    routable: (response) => requestIds.has(response.requestId),
  });
  return mapped.delivery === input.delivery
    ? { delivery: undefined }
    : { delivery: mapped.delivery, serializedContext: mapped.serializedContext };
}

/**
 * The payload without what went to askers, or `undefined` when nothing is
 * left. Channels attach context to each message, such as Telegram's sender
 * block; kept without its message, it would reach the model as one of its own.
 */
function remainderOf(
  payload: DeliverPayload,
  forwarded: ReadonlySet<string>,
  messageAnswered: boolean,
): DeliverPayload | undefined {
  const remainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "inputResponses" || value === undefined) continue;
    if (messageAnswered && MESSAGE_KEYS.has(key)) continue;
    remainder[key] = value;
  }
  const responses: InputResponse[] = (payload.inputResponses ?? []).filter(
    (response) => !forwarded.has(response.requestId),
  );
  if (responses.length > 0) remainder.inputResponses = responses;
  return Object.keys(remainder).length > 0 ? (remainder as DeliverPayload) : undefined;
}

function routeKey(route: RelayRoute): string {
  return JSON.stringify([
    route.childContinuationToken,
    route.childSessionInbox?.sessionId ?? null,
    route.remote?.sessionId ?? null,
    route.control ?? null,
    route.inputSource ?? null,
  ]);
}

/** The workflow tool run that relayed a question, and its control hook when the question is its own `ctx.ask()`. */
interface RelayedBy {
  readonly control?: string;
  readonly runId?: string;
}

/**
 * Relays one child event through the parent session, as human input: a
 * child's question waits for the answer this session routes back, and a
 * child's authorization waits for the callback the child completes it on.
 */
export async function relaySubagentEvent(
  target: SessionStepState &
    RelayedBy & {
      readonly hookPayload: SubagentAuthorizationEventHookPayload | SubagentInputRequestHookPayload;
    },
): Promise<PublishedSessionEvents> {
  const { hookPayload } = target;
  const { ending: _none, ...published } = await commitSessionStep(
    target,
    [relayedInterrupt(target)],
    hookPayload.kind === "subagent-input-request"
      ? {
          inputSource: JSON.stringify([
            hookPayload.childContinuationToken,
            hookPayload.inputSource ?? null,
          ]),
        }
      : {},
  );
  return published;
}

function relayedInterrupt(
  input: RelayedBy & {
    readonly hookPayload: SubagentAuthorizationEventHookPayload | SubagentInputRequestHookPayload;
  },
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

/**
 * Cancels the parked turn's human input: what it waits on closes, its held
 * step joins history with each call answered as not run, and what children
 * and runs relayed is withdrawn. Returns the session the cancel left, with
 * what the settle publishes, relays and adds to history.
 */
export async function cancelParkedTurn(parked: DurableSession): Promise<{
  readonly session: DurableSession;
  readonly own: readonly UnstampedMessageStreamEvent[];
  readonly relayed: readonly UnstampedMessageStreamEvent[];
  readonly history: readonly ModelMessage[];
}> {
  const host = new SessionHost();
  const cancelled = await HumanInput.commit(host, parked, { type: "cancel.requested" });
  return {
    history: host.history,
    own: host.own,
    relayed: host.relayed,
    session: cancelled.session,
  };
}
