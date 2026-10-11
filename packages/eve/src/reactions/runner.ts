import type { ModelMessage } from "ai";

import { getAdapterKind } from "#channel/adapter.js";
import type { ContextContainer } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  SessionIdKey,
  SessionPredecessorKey,
} from "#context/keys.js";
import { readSessionSchedule } from "#context/session-schedule.js";
import type { ReactionView, SelectContext } from "#dynamic/definition.js";
import type { WrittenEvent } from "#execution/publish-session-events.js";
import { currentProjection, currentView } from "#harness/session-machine/current.js";
import { createLogger } from "#internal/logging.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { bundleReactions } from "./bundle.js";
import { effectiveModelId } from "./kinds/model.js";
import {
  REACTION_ORDER,
  type BundleReactions,
  type InternalRecordContext,
  type Reaction,
  type ReactionKind,
  withMessages,
} from "./reaction.js";
import {
  canonicalJson,
  clearLive,
  digestOf,
  forgetSessionLive,
  readLive,
  readReactionsState,
  type ReactionsState,
  type Slot,
  writeLive,
  writeReactionsState,
} from "./state.js";
import { takeIntents } from "./intents.js";
import { latestTurn } from "./turn.js";

const log = createLogger("reactions");
const neverAborted = new AbortController().signal;

/** Thrown by `view.messages` in a step without the conversation; the runner skips that reaction. */
const CONVERSATION_UNAVAILABLE = Symbol("eve.reactions.conversation-unavailable");
/** The digest a slot keeps when its `select` threw, so the failure logs once. */
const SELECT_FAILED = "select-failed";

export interface RunReactionsInput {
  readonly written: readonly WrittenEvent[];
  readonly abortSignal?: AbortSignal;
  /** The conversation as of this commit, or `undefined` in a step that doesn't hold it. */
  readonly conversation?: readonly ModelMessage[];
  /** Stops the running turn; absent when this commit can't stop one. */
  readonly cancelTurn?: (cancel: { readonly hook: string; readonly reason?: string }) => void;
}

/**
 * Runs after every commit: each reaction's `select` reads the view, and `record` and `render` run
 * only when the selection changed since its slot was written. Slots change nothing else, so this settles.
 */
export async function runReactions(ctx: ContextContainer, input: RunReactionsInput): Promise<void> {
  const { reactions, effects } = await bundleReactions(ctx);
  writeReactionsState(ctx, withLatest(readReactionsState(ctx), input.written));
  // A compaction that starts acts on every compact intent waiting for one.
  if (startsCompaction(input.written)) takeIntents(ctx, (intent) => intent.type === "compact");
  if (reactions.length === 0) return;
  const line = input.written.at(-1)?.position.line ?? readReactionsState(ctx).latest["*"] ?? 0;
  const selectContext = selectContextOf(ctx);
  const revision = readReactionsState(ctx).revision;
  const changedKinds = new Set<ReactionKind>();
  const changedHooks = new Set<string>();
  // Streamed progress, such as content deltas, reaches hooks that handle it, and nothing else:
  // capabilities depend on facts, and a select per delta would cost every stream.
  const progressOnly = input.written.length > 0 && input.written.every(({ progress }) => progress);

  for (const reaction of reactions) {
    if (progressOnly && reaction.kind !== "hook") continue;
    let selection: JsonValue;
    try {
      selection = selectionOf(
        reaction,
        reactionView(ctx, reaction.kind, input.conversation),
        selectContext,
      );
    } catch (error) {
      if (error === CONVERSATION_UNAVAILABLE) continue;
      const failed = { digest: SELECT_FAILED, line, revision };
      if (withdraw(ctx, reaction, error, failed)) changedKinds.add(reaction.kind);
      continue;
    }
    const digest = digestOf(selection);
    const slot = readReactionsState(ctx).slots[reaction.id];
    if (slot !== undefined && slot.digest === digest && !staleUnder(slot, revision)) continue;
    const changed = await resolveInto(ctx, reaction, {
      abortSignal: input.abortSignal,
      conversation: input.conversation,
      digest,
      line,
      revision,
      selection,
      written: input.written,
    });
    if (!changed) continue;
    changedKinds.add(reaction.kind);
    if (reaction.kind === "hook") changedHooks.add(reaction.id);
  }

  for (const kind of changedKinds) await effects[kind]?.(ctx);
  actOnCancels(ctx, reactions, changedHooks, input.cancelTurn);
}

/**
 * Stops the running turn for the first cancel intent that targets it, and drops cancels whose turn
 * has ended. One the commit can't act on waits for a commit that can, while its turn still runs.
 */
function actOnCancels(
  ctx: ContextContainer,
  reactions: readonly Reaction[],
  changedHooks: ReadonlySet<string>,
  cancelTurn: RunReactionsInput["cancelTurn"],
): void {
  const turnId = currentProjection(ctx).activeTurnId;
  takeIntents(ctx, (intent) => intent.type === "cancel" && intent.turnId !== turnId);
  const pending = (readReactionsState(ctx).intents ?? []).filter(
    (intent) => intent.type === "cancel",
  );
  const [first] = pending;
  if (first === undefined) return;
  const hook = reactions.find(({ id }) => id === first.reactionId)?.label ?? first.reactionId;
  if (cancelTurn === undefined) {
    if (pending.some(({ reactionId }) => changedHooks.has(reactionId))) {
      log.warn("A hook's cancel() waits: this commit cannot stop the running turn", { hook });
    }
    return;
  }
  takeIntents(ctx, (intent) => intent.type === "cancel");
  cancelTurn({ hook, ...(first.reason === undefined ? {} : { reason: first.reason }) });
}

function startsCompaction(written: readonly WrittenEvent[]): boolean {
  return written.some(
    ({ event }) =>
      event.type === "context.started" &&
      (event.data as { readonly kind?: string }).kind === "compaction",
  );
}

/**
 * Renders the code of every slot that carries some, for a step in a process that didn't render it:
 * `render` runs with the JSON the slot recorded, and `record` doesn't run. What the code offers
 * must match what the session was offered, or the slot is withdrawn: eve fails closed rather than
 * switch. `revision` is the runtime revision the step runs; a slot another revision resolved is
 * built for this step without that check, and resolves again after the step's first commit.
 */
export async function restoreReactions(
  ctx: ContextContainer,
  input: { readonly abortSignal?: AbortSignal; readonly revision?: string } = {},
): Promise<void> {
  if (input.revision !== undefined) {
    writeReactionsState(ctx, { ...readReactionsState(ctx), revision: input.revision });
  }
  // A test seam: every step builds its code as a fresh process would.
  if (process.env.EVE_REACTIONS_COLD === "1") {
    const sessionId = ctx.get(SessionIdKey);
    if (sessionId !== undefined) forgetSessionLive(sessionId);
  }
  const { reactions } = await bundleReactions(ctx);
  const revision = readReactionsState(ctx).revision;
  for (const reaction of reactions) {
    const slot = readSlot(ctx, reaction.id);
    if (reaction.render === undefined || slot?.input === undefined) continue;
    if (readLive(ctx, reaction.id, slot) !== undefined) continue;
    const rctx = resolveContextOf(ctx, {
      abortSignal: input.abortSignal,
      digest: slot.digest,
      written: [],
    });
    log.debug("Rendering a reaction's code again from what its slot recorded", {
      reaction: reaction.label,
    });
    try {
      const contribution = await reaction.contribute(await reaction.render(slot.input, rctx), rctx);
      const offered = parseJsonValue(contribution.value ?? null);
      if (!staleUnder(slot, revision) && canonicalJson(offered) !== canonicalJson(slot.value)) {
        throw new Error(
          `"${reaction.label}" rendered something other than what this session was offered. eve fails closed rather than switch; the next change to its selection records it again.`,
        );
      }
      if (contribution.live !== undefined) writeLive(ctx, reaction.id, slot, contribution.live);
    } catch (error) {
      if (reaction.failure === "throw") throw error;
      withdraw(ctx, reaction, error, {
        digest: slot.digest,
        line: slot.since,
        revision: slot.revision,
      });
    }
  }
}

/** Applies every kind's slots to the step's process-local state, such as its connection registry. */
export async function applyReactionEffects(ctx: ContextContainer): Promise<void> {
  const { effects } = await bundleReactions(ctx);
  for (const effect of Object.values(effects)) await effect(ctx);
}

/** The slots of one kind, in run order, with their live contributions where this process has them. */
export function slotsOf(
  ctx: Parameters<typeof readReactionsState>[0],
  kind: ReactionKind,
): readonly { readonly id: string; readonly slot: Slot; readonly live?: unknown }[] {
  if (ctx === undefined) return [];
  const prefix = `${kind}:`;
  return Object.entries(readReactionsState(ctx).slots)
    .filter(([id]) => id.startsWith(prefix))
    .map(([id, slot]) => {
      const live = readLive(ctx, id, slot);
      return live === undefined ? { id, slot } : { id, live: live.live, slot };
    });
}

export function readSlot(
  ctx: Parameters<typeof readReactionsState>[0],
  id: string,
): Slot | undefined {
  return readReactionsState(ctx).slots[id];
}

function writeSlot(ctx: ContextContainer, id: string, slot: Slot | undefined): void {
  const state = readReactionsState(ctx);
  const slots = { ...state.slots };
  if (slot === undefined) delete slots[id];
  else slots[id] = slot;
  writeReactionsState(ctx, { ...state, slots });
}

/**
 * Whether a new runtime revision must record the slot again. Only slots with code, which another
 * revision's code built, and failed slots, which new code may fix, do. A data slot keeps its value
 * until its selection changes, so a redeploy doesn't re-run every reaction in every session; data
 * that changed code would produce differently stays as it was until then.
 */
function staleUnder(slot: Slot, revision: string | undefined): boolean {
  if (revision === undefined || slot.revision === revision) return false;
  return slot.input !== undefined || slot.error !== undefined;
}

/**
 * Records a new selection into its slot: `record` fetches, eve keeps its JSON when the value
 * carries code, and `render` makes the value. Returns whether the slot's contribution changed.
 */
async function resolveInto(
  ctx: ContextContainer,
  reaction: Reaction,
  run: {
    readonly abortSignal: AbortSignal | undefined;
    readonly conversation: readonly ModelMessage[] | undefined;
    readonly digest: string;
    readonly line: number;
    readonly revision: string | undefined;
    readonly selection: JsonValue;
    readonly written: readonly WrittenEvent[];
  },
): Promise<boolean> {
  const previous = readSlot(ctx, reaction.id);
  const rctx = resolveContextOf(ctx, {
    abortSignal: run.abortSignal,
    conversation: run.conversation,
    digest: run.digest,
    written: run.written,
  });
  let value: JsonValue;
  let live: unknown;
  let input: JsonValue | undefined;
  try {
    const recorded =
      reaction.record === undefined ? run.selection : await reaction.record(run.selection, rctx);
    let result = recorded;
    if (reaction.render !== undefined) {
      input = recordable(reaction, recorded);
      result = await reaction.render(input, rctx);
    }
    const contribution = await reaction.contribute(result, rctx);
    value = parseJsonValue(contribution.value ?? null);
    live = contribution.live;
  } catch (error) {
    // record read the conversation in a commit without it: the next commit that has it records.
    if (error === CONVERSATION_UNAVAILABLE) return false;
    if (reaction.failure === "throw") throw error;
    return withdraw(ctx, reaction, error, run);
  }
  const unchanged =
    previous !== undefined && canonicalJson(previous.value) === canonicalJson(value);
  const slot: Slot = {
    digest: run.digest,
    since: unchanged ? previous.since : run.line,
    value,
    ...(live === undefined || input === undefined ? {} : { input }),
    ...(run.revision === undefined ? {} : { revision: run.revision }),
  };
  writeSlot(ctx, reaction.id, slot);
  if (live === undefined) clearLive(ctx, reaction.id);
  else writeLive(ctx, reaction.id, slot, live);
  return !unchanged;
}

/** What `render` renders from, which eve keeps: it must be JSON. */
function recordable(reaction: Reaction, recorded: unknown): JsonValue {
  try {
    return parseJsonValue(recorded ?? null);
  } catch {
    throw new Error(
      `The record of "${reaction.label}" must return JSON: eve keeps it, and render makes the value from it. Return the data, and create tools, clients, or models in render.`,
    );
  }
}

/**
 * A throw withdraws the slot's contribution; the kind's readers then see nothing from it. The slot
 * keeps the failed selection's digest, so the reaction retries when its selection or the runtime
 * revision changes rather than on every commit.
 */
function withdraw(
  ctx: ContextContainer,
  reaction: Reaction,
  error: unknown,
  failed: { readonly digest: string; readonly line: number; readonly revision?: string },
): boolean {
  const previous = readSlot(ctx, reaction.id);
  if (previous?.digest !== failed.digest || previous.value !== null) {
    // A model selection's failure is reported by the model call that needs it.
    (reaction.kind === "model" ? log.warn : log.error)(
      `Reaction "${reaction.label}" failed; its contribution is withdrawn.`,
      { error: toErrorMessage(error), kind: reaction.kind },
    );
  }
  const had = previous !== undefined && previous.value !== null;
  writeSlot(ctx, reaction.id, {
    digest: failed.digest,
    error: toErrorMessage(error),
    since: had ? failed.line : (previous?.since ?? failed.line),
    value: null,
    ...(failed.revision === undefined ? {} : { revision: failed.revision }),
  });
  clearLive(ctx, reaction.id);
  return had;
}

/** The largest selection eve digests after every commit, as JSON characters. */
const SELECTION_CAP = 64 * 1024;

function selectionOf(reaction: Reaction, view: ReactionView, ctx: SelectContext): JsonValue {
  if (reaction.select === undefined) return null;
  const selected = reaction.select(view, ctx);
  let selection: JsonValue;
  try {
    selection = parseJsonValue(selected ?? null);
  } catch {
    throw new Error(`The select of "${reaction.label}" must return JSON.`);
  }
  const size = JSON.stringify(selection).length;
  if (size > SELECTION_CAP) {
    throw new Error(
      `The select of "${reaction.label}" returned ${Math.ceil(size / 1024)} KB of JSON; a selection is at most 64 KB. Select an ID that record can look up instead.`,
    );
  }
  return selection;
}

function withLatest(state: ReactionsState, written: readonly WrittenEvent[]): ReactionsState {
  if (written.length === 0) return state;
  const latest = { ...state.latest };
  for (const { event, position, progress } of written) {
    latest[event.type] = position.line;
    if (!progress) latest["*"] = position.line;
    if (event.type === "context.started" || event.type === "context.settled") {
      latest[`${event.type}:${(event.data as { readonly kind?: string }).kind ?? ""}`] =
        position.line;
    }
  }
  return { ...state, latest };
}

/** Kinds that run before the model this commit, so can't read the model it chooses. */
const BEFORE_MODEL = new Set<ReactionKind>(
  REACTION_ORDER.slice(0, REACTION_ORDER.indexOf("model") + 1),
);

/**
 * The view a reaction of `kind` selects from. It holds only what earlier kinds have contributed
 * this commit: a kind that runs before the model, or the model itself, would otherwise read the
 * previous commit's model.
 */
function reactionView(
  ctx: ContextContainer,
  kind: ReactionKind,
  conversation: readonly ModelMessage[] | undefined,
): ReactionView {
  const latest = readReactionsState(ctx).latest;
  return Object.defineProperties(
    { ...currentView(ctx) },
    {
      latest: { enumerable: true, value: latest },
      turn: { enumerable: true, value: latestTurn(currentView(ctx)) },
      messages: {
        enumerable: true,
        get() {
          if (conversation === undefined) throw CONVERSATION_UNAVAILABLE;
          return conversation;
        },
      },
      model: {
        enumerable: true,
        get() {
          if (BEFORE_MODEL.has(kind)) {
            throw new Error(
              `view.model isn't available to a ${kind} reaction: it runs before the model is chosen. Select the model from a capability instead.`,
            );
          }
          const id = effectiveModelId(ctx);
          return id === undefined ? null : { id };
        },
      },
    },
  ) as ReactionView;
}

export function selectContextOf(ctx: Pick<ContextContainer, "get">): SelectContext {
  const channel = ctx.get(ChannelKey);
  const conversation = ctx.get(ConversationContextKey);
  return {
    channel: {
      continuationToken: ctx.get(ContinuationTokenKey),
      kind: channel === undefined ? undefined : getAdapterKind(channel),
      metadata: ctx.get(ChannelInstrumentationKey)?.metadata,
    },
    ...(conversation === undefined ? {} : { conversation }),
    session: {
      auth: { current: ctx.get(AuthKey) ?? null, initiator: ctx.get(InitiatorAuthKey) ?? null },
      id: ctx.get(SessionIdKey) ?? "",
      predecessor: ctx.get(SessionPredecessorKey),
      schedule: readSessionSchedule(ctx),
    },
  };
}

function resolveContextOf(
  ctx: ContextContainer,
  input: {
    readonly abortSignal: AbortSignal | undefined;
    readonly conversation?: readonly ModelMessage[];
    readonly digest: string;
    readonly written: readonly WrittenEvent[];
  },
): InternalRecordContext {
  return withMessages(
    {
      ...selectContextOf(ctx),
      abortSignal: input.abortSignal ?? neverAborted,
      ctx,
      digest: input.digest,
      facts: input.written.map(({ event }) => event),
      written: input.written,
    },
    () => {
      if (input.conversation === undefined) throw CONVERSATION_UNAVAILABLE;
      return input.conversation;
    },
  );
}

export type { BundleReactions };
