import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
import { vercelOidc } from "#public/channels/auth.js";
import {
  chatSdkChannel,
  type ChatSdkChannel,
  type ChatSdkChannelBridge,
  type ChatSdkChannelEvents,
} from "#public/channels/chat-sdk/index.js";
import type { Message, Thread } from "#compiled/chat/index.js";
import { createMemoryState } from "#compiled/@chat-adapter/state-memory/index.js";
import {
  createiMessageAdapter,
  type iMessageAdapter,
  type iMessageCredentialProvider,
  type iMessageWebhookVerifier,
} from "#compiled/@photon-ai/chat-adapter-imessage/index.js";
import { photonInboundContent } from "#public/channels/photon/inboundContent.js";
import { pollInputRequested, pollVote } from "#public/channels/photon/polls.js";

/** Photon project credentials used by {@link photonIMessageChannel}. */
export type PhotonIMessageChannelCredentials = iMessageCredentialProvider;

/** Context passed to {@link PhotonIMessageChannelConfig.onMessage}. */
export interface PhotonInboundMessageContext {
  /** Low-level Chat SDK thread for iMessage-specific operations. */
  readonly thread: Thread;
}

/** Result of {@link PhotonIMessageChannelConfig.onMessage}. Return `null` to drop the message. */
export type PhotonInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  /** Overrides the workflow run title without changing the message sent to the model. */
  readonly title?: string;
} | null;

/** Sync or async {@link PhotonInboundResult}. */
export type PhotonInboundResultOrPromise = PhotonInboundResult | Promise<PhotonInboundResult>;

/** Configuration for {@link photonIMessageChannel}. */
export interface PhotonIMessageChannelConfig {
  /** Lazy Photon project credentials, such as `connectPhotonCredentials(...)`. */
  readonly credentials: PhotonIMessageChannelCredentials;
  /** Per-event overrides for the underlying Chat SDK channel. */
  readonly events?: ChatSdkChannelEvents<{ imessage: iMessageAdapter }>;
  /** Inbound message policy. Defaults to dispatching with the Photon message author's user auth. */
  readonly onMessage?: (
    ctx: PhotonInboundMessageContext,
    message: Message,
  ) => PhotonInboundResultOrPromise;
  /**
   * Experimental. Ask questions and tool approvals as native iMessage polls, so
   * a person can answer by voting or by typing. Option descriptions are not
   * shown. Requests without 2 to 10 distinct options stay numbered text.
   * Defaults to `false`.
   */
  readonly questionsAsPolls?: boolean;
  /** Override the default webhook route (`/eve/v1/photon`). */
  readonly route?: string;
  /** Policy for accepted messages that arrive while a turn is active. */
  readonly turnPolicy?: TurnPolicy;
  /** Display name used by the Chat SDK runtime. Defaults to `"eve"`. */
  readonly userName?: string;
  /** Photon webhook signing secret. Falls back to `IMESSAGE_WEBHOOK_SECRET`. */
  readonly webhookSecret?: string;
  /** Trusted webhook verifier. Takes precedence over `webhookSecret`. */
  readonly webhookVerifier?: iMessageWebhookVerifier;
}

/** First-class eve channel backed by Photon iMessage. */
export interface PhotonIMessageChannel extends ChatSdkChannel {}

/**
 * Creates an eve channel for Photon-powered iMessage.
 *
 * @example
 * ```ts
 * import { connectPhotonCredentials } from "@vercel/connect/eve";
 * import { photonIMessageChannel } from "eve/channels/photon";
 *
 * export default photonIMessageChannel({
 *   credentials: connectPhotonCredentials("photon/my-agent"),
 * });
 * ```
 */
export function photonIMessageChannel(config: PhotonIMessageChannelConfig): PhotonIMessageChannel {
  const webhookSecret = config.webhookSecret ?? process.env.IMESSAGE_WEBHOOK_SECRET;
  const imessage = createiMessageAdapter({
    credentials: config.credentials,
    ...(config.webhookVerifier
      ? { webhookVerifier: config.webhookVerifier }
      : webhookSecret
        ? { webhookSecret }
        : { webhookVerifier: vercelOidc() }),
  });
  const bridge = chatSdkChannel({
    adapters: { imessage },
    concurrency: "concurrent",
    events: config.questionsAsPolls
      ? { "input.requested": pollInputRequested, ...config.events }
      : config.events,
    routes: { imessage: config.route ?? "/eve/v1/photon" },
    state: createMemoryState(),
    streaming: false,
    turnPolicy: config.turnPolicy,
    userName: config.userName ?? "eve",
  });
  const dispatch = {
    onMessage: config.onMessage ?? defaultOnMessage,
    polls: config.questionsAsPolls === true,
  };

  bridge.bot.onDirectMessage(async (thread: Thread, message: Message) => {
    await dispatchMessage(bridge, dispatch, thread, message);
  });
  bridge.bot.onNewMessage(/[\s\S]*/, async (thread: Thread, message: Message) => {
    await dispatchMessage(bridge, dispatch, thread, message);
  });

  return bridge.channel;
}

/** Default Photon auth projection for inbound Chat SDK message authors. */
export function defaultPhotonAuth(message: Message): SessionAuthContext {
  const attributes: Record<string, string> = {};
  if (message.author.userName !== undefined) attributes.user_name = message.author.userName;
  return {
    attributes,
    authenticator: "photon-imessage",
    issuer: "photon",
    principalId: `photon:${message.author.userId}`,
    principalType: message.author.isBot ? "service" : "user",
    subject: message.author.userId,
  };
}

async function defaultOnMessage(
  _ctx: PhotonInboundMessageContext,
  message: Message,
): Promise<PhotonInboundResult> {
  return { auth: defaultPhotonAuth(message) };
}

async function dispatchMessage(
  bridge: ChatSdkChannelBridge<{ imessage: iMessageAdapter }>,
  dispatch: {
    readonly onMessage: NonNullable<PhotonIMessageChannelConfig["onMessage"]>;
    readonly polls: boolean;
  },
  thread: Thread,
  message: Message,
): Promise<void> {
  const vote = dispatch.polls ? pollVote(message) : undefined;
  if (vote === null) return;
  const result = await dispatch.onMessage({ thread }, message);
  if (result === null) return;
  await markReadBestEffort(bridge.bot.getAdapter("imessage"), thread, message);
  const content = vote ?? photonInboundContent(message);
  if (content === undefined) return;
  await bridge.send(content, {
    auth: result.auth,
    context: [...(result.context ?? [])],
    thread,
    title: result.title,
  });
}

async function markReadBestEffort(
  adapter: iMessageAdapter,
  thread: Thread,
  message: Message,
): Promise<void> {
  try {
    await adapter.markRead(thread.id, message.id);
  } catch {
    // A read receipt should never prevent the user's message from reaching eve.
  }
}
