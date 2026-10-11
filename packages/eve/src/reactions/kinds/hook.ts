import { getAdapterKind } from "#channel/adapter.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { runOnSelection, type ContextContainer } from "#context/container.js";
import { ContinuationTokenKey } from "#context/keys.js";
import type { ReactionView } from "#dynamic/definition.js";
import { createLogger, logError } from "#internal/logging.js";
import type { HookContext, HookRecordContext } from "#public/definitions/hook.js";
import type { ResolvedHookDefinition } from "#runtime/types.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { queueIntents, type Occurrence } from "../intents.js";
import {
  authoredRender,
  withMessages,
  type InternalRecordContext,
  type Reaction,
} from "../reaction.js";

const log = createLogger("hooks");

/**
 * An authored hook as a reaction: `select` with `record` or `render`, or `events` handlers. What
 * it returns are intents, which act once per occurrence: each new selection, or each fact an
 * events handler receives. Side effects belong in `record`, which runs once per selection and
 * gets `ctx.occurrence` as an idempotency key. The slot holds the latest occurrences that asked
 * for something, for change detection.
 */
export function hookReaction(hook: ResolvedHookDefinition): Reaction {
  const id = `hook:${hook.slug}`;
  const base = { id, kind: "hook" as const, label: hook.logicalPath };
  if (hook.select !== undefined) {
    const record = hook.record as
      | ((selected: unknown, ctx: HookRecordContext) => unknown)
      | undefined;
    return {
      ...base,
      contribute: (result, ctx) => ({
        value: queueIntents(ctx.ctx, id, hook.logicalPath, [
          { occurrence: occurrenceOf(ctx, hook), result },
        ]),
      }),
      ...(record === undefined
        ? {}
        : {
            record: (selected: unknown, ctx: InternalRecordContext) => {
              // Built in the session's context, which record itself runs outside of.
              const hookContext = hookRecordContext(ctx, occurrenceOf(ctx, hook));
              return runOnSelection(hook.logicalPath, () => record(selected, hookContext));
            },
          }),
      render: authoredRender(hook.logicalPath, hook.render),
      select: hook.select as (view: ReactionView, ctx: unknown) => unknown,
    };
  }
  const keys = Object.keys(hook.events).sort();
  return {
    ...base,
    contribute: (results, ctx) => ({
      value: queueIntents(ctx.ctx, id, hook.logicalPath, results as readonly Occurrence[]),
    }),
    record: (_selected, ctx) => dispatchEvents(hook, ctx),
    select: (view) => keys.map((key) => view.latest[key] ?? null),
  };
}

/** A select-form hook's occurrence: the hook, and its selection. */
function occurrenceOf(ctx: InternalRecordContext, hook: ResolvedHookDefinition): string {
  return `${ctx.session.id}:${hook.slug}:${ctx.digest}`;
}

/** Runs the hook's handlers for each record the commit carries, typed handler first, then `*`. */
async function dispatchEvents(
  hook: ResolvedHookDefinition,
  ctx: InternalRecordContext,
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

function hookRecordContext(ctx: InternalRecordContext, occurrence: string): HookRecordContext {
  const base = hookContextBase(ctx.ctx);
  return withMessages(
    {
      abortSignal: ctx.abortSignal,
      agent: base.agent,
      channel: { ...ctx.channel, ...base.channel },
      ...(ctx.conversation === undefined ? {} : { conversation: ctx.conversation }),
      getSandbox: base.getSandbox,
      occurrence,
      session: { ...base.session, auth: ctx.session.auth },
    },
    () => ctx.messages,
  );
}
