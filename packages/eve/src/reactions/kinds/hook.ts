import { getAdapterKind } from "#channel/adapter.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { runOnSelection, type ContextContainer } from "#context/container.js";
import { ContinuationTokenKey } from "#context/keys.js";
import type { ReactionView } from "#dynamic/definition.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  INTENT_KIND,
  type HookContext,
  type HookIntent,
  type HookResolveContext,
} from "#public/definitions/hook.js";
import type { ResolvedHookDefinition } from "#runtime/types.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { JsonValue } from "#shared/json.js";
import type { InternalResolveContext, Reaction } from "../reaction.js";
import { readReactionsState, writeReactionsState, type PendingIntent } from "../state.js";

const log = createLogger("hooks");

/**
 * An authored hook as a reaction. A hook's results are occurrences, not a value: each new selection,
 * or each record an `events` handler receives, is one occurrence, and the intents it returns are
 * acted on once for it. The slot holds only the latest occurrences, for change detection.
 */
export function hookReaction(hook: ResolvedHookDefinition): Reaction {
  const id = `hook:${hook.slug}`;
  const base = {
    contribute: (results: unknown, ctx: InternalResolveContext) => ({
      value: queueIntents(ctx.ctx, id, hook.logicalPath, results as readonly Occurrence[]),
    }),
    id,
    kind: "hook" as const,
    label: hook.logicalPath,
  };
  if (hook.resolve !== undefined) {
    const resolve = hook.resolve as (selected: unknown, ctx: HookResolveContext) => unknown;
    return {
      ...base,
      resolve: async (selected, ctx) => {
        const occurrence = `${ctx.session.id}:${hook.slug}:${ctx.digest}`;
        const hookContext = { ...hookResolveContext(ctx), occurrence };
        const result = await runOnSelection(hook.logicalPath, () => resolve(selected, hookContext));
        return [{ occurrence, result }];
      },
      ...(hook.select === undefined
        ? {}
        : { select: hook.select as (view: ReactionView, ctx: unknown) => unknown }),
    };
  }
  const keys = Object.keys(hook.events).sort();
  return {
    ...base,
    resolve: (_selected, ctx) => dispatchEvents(hook, ctx),
    select: (view) => keys.map((key) => view.latest[key] ?? null),
  };
}

/** One occurrence and what the hook returned for it. */
interface Occurrence {
  readonly occurrence: string;
  readonly result: unknown;
}

/** Runs the hook's handlers for each record the commit carries, typed handler first, then `*`. */
async function dispatchEvents(
  hook: ResolvedHookDefinition,
  ctx: InternalResolveContext,
): Promise<readonly Occurrence[]> {
  const results: Occurrence[] = [];
  if (ctx.written.length === 0) return results;
  const base = hookContextBase(ctx.ctx);
  for (const { event: written, position, progress, view } of ctx.written) {
    const { meta: _meta, ...event } = written;
    const occurrence = `${base.session.id}:${hook.slug}:${position.line}.${position.index}`;
    const handlers = [hook.events[event.type], progress ? undefined : hook.events["*"]];
    for (const handler of handlers) {
      if (handler === undefined) continue;
      const hookContext: HookContext = { ...base, occurrence, position, view };
      try {
        results.push({ occurrence, result: await handler(event as never, hookContext) });
      } catch (error) {
        logError(log, "stream event hook failed", error, {
          eventType: event.type,
          hook: hook.slug,
          position,
          sessionId: base.session.id,
        });
      }
    }
  }
  return results;
}

function hookContextBase(
  ctx: ContextContainer,
): Omit<HookContext, "occurrence" | "position" | "view"> {
  const bundle = ctx.require(BundleKey);
  const channelAdapter = ctx.get(ChannelKey);
  return {
    ...buildCallbackContext(),
    agent: { name: bundle.turnAgent.id, nodeId: bundle.nodeId },
    channel: {
      continuationToken: ctx.get(ContinuationTokenKey),
      kind: channelAdapter === undefined ? undefined : getAdapterKind(channelAdapter),
    },
  };
}

function hookResolveContext(ctx: InternalResolveContext): Omit<HookResolveContext, "occurrence"> {
  const base = hookContextBase(ctx.ctx);
  return {
    abortSignal: ctx.abortSignal,
    agent: base.agent,
    channel: { ...ctx.channel, ...base.channel },
    ...(ctx.conversation === undefined ? {} : { conversation: ctx.conversation }),
    getSandbox: base.getSandbox,
    session: { ...base.session, auth: ctx.session.auth },
  };
}

/**
 * Records the intents each occurrence returned, once per occurrence and type, and returns the
 * occurrences that asked for something. A cancel targets the turn running now, and is dropped
 * when none is.
 */
function queueIntents(
  ctx: ContextContainer,
  reactionId: string,
  label: string,
  occurrences: readonly Occurrence[],
): JsonValue {
  const state = readReactionsState(ctx);
  const intents = [...(state.intents ?? [])];
  const asked: string[] = [];
  const turnId = currentProjection(ctx).activeTurnId;
  for (const { occurrence, result } of occurrences) {
    for (const intent of intentsOf(result, label)) {
      if (intent.type === "cancel" && turnId === undefined) continue;
      if (
        intents.some((queued) => queued.occurrence === occurrence && queued.type === intent.type)
      ) {
        continue;
      }
      intents.push({
        occurrence,
        reactionId,
        type: intent.type,
        ...(intent.reason === undefined ? {} : { reason: intent.reason }),
        ...(intent.type === "cancel" ? { turnId } : {}),
      });
      if (!asked.includes(occurrence)) asked.push(occurrence);
    }
  }
  if (asked.length > 0) writeReactionsState(ctx, { ...state, intents });
  return asked.length === 0 ? null : asked;
}

/** The intents in a hook's result: one, several, or a map of them, whose names don't matter. */
function intentsOf(result: unknown, label: string): readonly HookIntent[] {
  if (result === null || result === undefined) return [];
  if (Array.isArray(result)) return result.flatMap((entry) => intentsOf(entry, label));
  if (typeof result !== "object") throw notAnIntent(label);
  if ((result as Partial<HookIntent>).kind === INTENT_KIND) return [result as HookIntent];
  return Object.values(result).flatMap((entry) => {
    if (entry === null || entry === undefined) return [];
    if ((entry as Partial<HookIntent>).kind !== INTENT_KIND) throw notAnIntent(label);
    return [entry as HookIntent];
  });
}

function notAnIntent(label: string): Error {
  return new Error(
    `Hook "${label}" returned something other than intents. Return cancel(), compact(), several of them, or nothing.`,
  );
}

/** Removes and returns the waiting intents that match, because the session acted on them. */
export function takeIntents(
  ctx: ContextContainer,
  matches: (intent: PendingIntent) => boolean,
): readonly PendingIntent[] {
  const state = readReactionsState(ctx);
  const taken = (state.intents ?? []).filter(matches);
  if (taken.length === 0) return taken;
  const intents = (state.intents ?? []).filter((intent) => !matches(intent));
  writeReactionsState(ctx, { ...state, intents });
  return taken;
}

/** True while a hook's compact intent waits for a compaction to start. */
export function hasPendingCompaction(ctx: Pick<ContextContainer, "get"> | undefined): boolean {
  return (readReactionsState(ctx).intents ?? []).some((intent) => intent.type === "compact");
}
