import type { InputRequest } from "#shared/input.js";
import { type Message, Modal, Select, SelectOption } from "#compiled/chat/index.js";
import type { iMessageAdapter } from "#compiled/@photon-ai/chat-adapter-imessage/index.js";
import type { ChatSdkChannelEvents } from "#public/channels/chat-sdk/index.js";
import {
  DEFAULT_INPUT_ACTION_PREFIX,
  renderInputRequests,
} from "#public/channels/chat-sdk/input-actions.js";

// iMessage polls take 2 to 10 options and a title of at most 300 characters.
const MIN_POLL_OPTIONS = 2;
const MAX_POLL_OPTIONS = 10;
const MAX_POLL_TITLE = 300;
const POLL_CALLBACK_ID = "eve_input_poll";
const POLL_SELECT_ID = "option";

type PhotonEvents = ChatSdkChannelEvents<{ imessage: iMessageAdapter }>;

/**
 * Posts each pending request that fits an iMessage poll as a native poll, and
 * the rest as numbered text. A vote reaches eve as a reply with the option's
 * label, so it resolves the same way a typed reply does, and a person can still
 * type an answer instead.
 */
export const pollInputRequested: NonNullable<PhotonEvents["input.requested"]> = async (
  event,
  channel,
) => {
  const thread = channel.thread;
  if (!thread || event.requests.length === 0) return;
  const adapter = channel.bot.getAdapter("imessage");
  const textRequests: InputRequest[] = [];
  for (const request of event.requests) {
    if (!fitsPoll(request)) {
      textRequests.push(request);
      continue;
    }
    // The adapter's only public poll API is its modal mapping: a modal title
    // becomes the poll question and its select becomes the poll options.
    await adapter.openModal(
      thread.id,
      Modal({
        callbackId: POLL_CALLBACK_ID,
        children: [
          Select({
            id: POLL_SELECT_ID,
            label: request.prompt,
            options: request.options!.map((option) =>
              SelectOption({ label: option.label, value: option.id }),
            ),
          }),
        ],
        title: request.prompt,
      }),
    );
  }
  if (textRequests.length > 0) {
    await thread.post(renderInputRequests(textRequests, DEFAULT_INPUT_ACTION_PREFIX));
  }
};

function fitsPoll(request: InputRequest): boolean {
  const labels = (request.options ?? []).map((option) => option.label);
  return (
    labels.length >= MIN_POLL_OPTIONS &&
    labels.length <= MAX_POLL_OPTIONS &&
    new Set(labels).size === labels.length &&
    request.prompt.length > 0 &&
    request.prompt.length <= MAX_POLL_TITLE
  );
}

interface PollVoteContent {
  readonly type: "poll_option";
  readonly option?: { readonly title?: string };
  readonly selected?: boolean;
}

/**
 * The option label a person chose in an iMessage poll, `null` for another poll
 * event (such as removing a vote), or `undefined` when the message isn't a poll
 * event. Photon delivers votes as messages with no text.
 */
export function pollVote(message: Message): string | null | undefined {
  const content = (message.raw as { readonly content?: { readonly type?: string } } | null)
    ?.content;
  if (content?.type !== "poll_option") return undefined;
  const vote = content as PollVoteContent;
  const label = vote.option?.title;
  return vote.selected === true && label !== undefined && label.length > 0 ? label : null;
}
