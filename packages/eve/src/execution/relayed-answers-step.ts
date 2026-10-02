import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { deserializeContext } from "#context/serialize.js";
import {
  resolveRemoteAgentStreamHeaders,
  respondToRemoteAgentSession,
} from "#execution/agent-sessions/remote.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import { relaySessionEvents, type SessionStepState } from "#execution/publish-session-events.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { deliverChannelInputResponses } from "#execution/session/held-input-responses.js";
import {
  withSessionStateDelta,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { sendWorkflowAskAnswers } from "#execution/tools/workflow/answer.js";
import { HumanInput, type RelayRoute } from "#harness/human-input/index.js";
import { inputTextKey, readAnswerText } from "#internal/input-text.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { InputResponse } from "#shared/input.js";

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

/** The answers one asker receives, in the order the delivery carried them. */
interface Forward {
  readonly route: RelayRoute;
  readonly payloads: DeliverPayload[];
  readonly metadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][];
}

/** Payload keys that describe the message, dropped with it when it answers a question. */
const MESSAGE_KEYS: ReadonlySet<string> = new Set(["context", "message", inputTextKey]);

/**
 * Forwards the answers a delivery carries for relayed requests to whoever
 * asked, and relays the `input.resolved` for them once they are on their way.
 * Returns what is left for this session's turn, or `cancel-turn` when an
 * answer was a relayed budget Stop.
 */
export async function forwardRelayedAnswersStep(
  input: SessionStepState & { readonly delivery: DeliverHookPayload },
): Promise<WithSessionStateDelta<ForwardedRelayedAnswers>> {
  "use step";
  return await withSessionStateDelta(input, forwardRelayedAnswers);
}

async function forwardRelayedAnswers(
  input: SessionStepState & { readonly delivery: DeliverHookPayload },
): Promise<ForwardedRelayedAnswers> {
  const session = readDurableSession(input.sessionState);
  let humanInput = HumanInput.read(session.state);
  const relayed = humanInput.relayedRequestIds();
  // Some channels answer with ids only their `deliver` hook resolves, such as
  // Telegram's compact button callbacks.
  const { delivery, serializedContext } = await deliverChannelInputResponses({
    ...input,
    routable: (response) => relayed.has(response.requestId),
  });
  const delegated = hasDelegatedSessionContext(serializedContext) || delivery.caller !== undefined;

  const forwards = new Map<string, Forward>();
  const published: UnstampedMessageStreamEvent[] = [];
  const kept: [index: number, payload: DeliverPayload][] = [];
  let cancelled = false;
  for (const [index, payload] of delivery.payloads.entries()) {
    const text = readAnswerText(payload);
    const transition = humanInput.intake({
      responses: payload.inputResponses ?? [],
      ...(text !== undefined && { message: { delegated, text } }),
      type: "delivered",
    });
    humanInput = transition.humanInput;
    const forwarded = new Set<string>();
    let messageAnswered = false;
    let first: Forward | undefined;
    for (const event of transition.events) {
      switch (event.type) {
        case "answer.forwarded": {
          const key = routeKey(event.route);
          const forward = forwards.get(key) ?? { metadata: [], payloads: [], route: event.route };
          forwards.set(key, forward);
          forward.payloads.push({ inputResponses: event.responses });
          for (const response of event.responses) forwarded.add(response.requestId);
          first ??= forward;
          continue;
        }
        case "publish":
          published.push(event.event);
          continue;
        case "message.answered":
          messageAnswered = true;
          continue;
        case "turn.cancelled":
          cancelled = true;
          continue;
        default:
          throw new Error(`Human input event "${event.type}" does not follow a delivery.`);
      }
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

  for (const forward of forwards.values()) await send(forward, delivery, serializedContext);

  const context = await relaySessionEvents(
    {
      serializedContext,
      sessionState: replaceDurableSessionSnapshot({
        session: { ...session, state: humanInput.write(session.state) },
        state: input.sessionState,
      }),
      sessionWritable: input.sessionWritable,
    },
    published,
  );
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

async function send(
  forward: Forward,
  delivery: DeliverHookPayload,
  serializedContext: Record<string, unknown>,
): Promise<void> {
  const { route } = forward;
  const responses = forward.payloads.flatMap((payload) => payload.inputResponses ?? []);
  if (route.control !== undefined) {
    await sendWorkflowAskAnswers(route.control, responses, delivery.auth);
    return;
  }
  if (route.remote !== undefined) {
    const ctx = await deserializeContext(serializedContext);
    const headers = await resolveRemoteAgentStreamHeaders({
      bundle: ctx.require(BundleKey),
      name: route.remote.name,
      resolverId: route.remote.resolverId,
      url: route.remote.url,
    });
    await respondToRemoteAgentSession({
      auth: delivery.auth,
      headers,
      remote: route.remote,
      responses,
    });
    return;
  }
  await resumeSessionInbox(route.childSessionInbox ?? route.childContinuationToken, {
    ...delivery,
    deliveryMetadata: forward.metadata.length === 0 ? undefined : forward.metadata,
    payloads: forward.payloads,
  });
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
