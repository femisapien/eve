import type { ModelMessage } from "ai";

import type { SessionEvent } from "#protocol/session-event.js";

import { runOnSelection, type ContextContainer } from "#context/container.js";
import type { ReactionView, ResolveContext, SelectContext } from "#dynamic/definition.js";
import type { WrittenEvent } from "#execution/publish-session-events.js";
import type { JsonValue } from "#shared/json.js";

/** The kinds of contribution, by the code that reads them. */
export type ReactionKind =
  | "hook"
  | "memory"
  | "model"
  | "connection"
  | "subagent"
  | "tool"
  | "skill"
  | "instructions";

/**
 * The order reactions run in after each commit. A reaction may select what an earlier kind
 * contributed, never a later one, so there is no dependency graph to resolve.
 */
export const REACTION_ORDER: readonly ReactionKind[] = [
  "hook",
  "memory",
  "model",
  "connection",
  "subagent",
  "tool",
  "skill",
  "instructions",
];

/** What a reaction contributes: its JSON form, and the code that form can't carry. */
export interface Contribution {
  readonly value: JsonValue;
  readonly live?: unknown;
}

/** What eve's own reactions receive besides the public {@link ResolveContext}. */
export interface InternalResolveContext extends ResolveContext {
  readonly ctx: ContextContainer;
  /** The commit's records with their positions, empty when a fresh process builds code. */
  readonly written: readonly WrittenEvent[];
  /** The commit's events, for eve's own effects; authored `resolve` never sees them. */
  readonly facts: readonly SessionEvent[];
  /** The conversation, for a reaction that declares it reads one. */
  readonly messages?: readonly ModelMessage[];
  /** The digest of the selection this run is for: a hook's occurrence. */
  readonly digest: string;
}

/** One reaction as the runner sees it. Every surface desugars to this. */
export interface Reaction {
  readonly id: string;
  readonly kind: ReactionKind;
  /** Where it was authored, for errors and logs. */
  readonly label: string;
  readonly select?: (view: ReactionView, ctx: SelectContext) => unknown;
  /** Fetches what the value is made of, once per new selection. Without it, that's the selection. */
  readonly resolve?: (selected: unknown, ctx: InternalResolveContext) => unknown;
  /**
   * Creates the code the value carries from the JSON eve records: what `resolve` returned, or the
   * selection. A process that didn't build it calls it with the recorded JSON; nothing calls
   * `resolve` again for a selection it resolved. Without it, `resolve`'s result is the value.
   */
  readonly build?: (input: JsonValue, ctx: InternalResolveContext) => unknown;
  /** Validates and names the value. Throws on a value the kind can't read. */
  readonly contribute: (
    result: unknown,
    ctx: InternalResolveContext,
  ) => Contribution | Promise<Contribution>;
  /** Reads the conversation in `resolve`, so it runs only where the step has it. */
  readonly conversation?: boolean;
  /** A failure fails the commit instead of withdrawing the slot. */
  readonly failure?: "throw";
}

/** The bundle's reactions in run order, and what each kind does once its slots change. */
export interface BundleReactions {
  readonly reactions: readonly Reaction[];
  readonly effects: Partial<Record<ReactionKind, (ctx: ContextContainer) => Promise<void>>>;
}

/**
 * An authored `resolve` as a reaction's: it runs outside the session's context and gets only the
 * public {@link ResolveContext}, so it depends on its selection alone.
 */
export function authoredResolve(
  label: string,
  resolve: ((selected: never, ctx: never) => unknown) | undefined,
  options: { readonly framework?: boolean } = {},
): Reaction["resolve"] {
  if (resolve === undefined) return undefined;
  if (options.framework === true) return resolve as Reaction["resolve"];
  return (selected, ctx) =>
    runOnSelection(label, () => resolve(selected as never, publicResolveContext(ctx) as never));
}

/**
 * An authored `build` as a reaction's: synchronous, outside the session's context, and given only
 * the recorded JSON. eve's own builds, such as a memory slot's tools, run in context and may wait.
 */
export function authoredBuild(
  label: string,
  build: ((input: never, ctx: never) => unknown) | undefined,
  options: { readonly framework?: boolean } = {},
): Reaction["build"] {
  if (build === undefined) return undefined;
  if (options.framework === true) return build as Reaction["build"];
  return (input) => {
    const built = runOnSelection(label, () => build(input as never, undefined as never));
    if (typeof (built as { then?: unknown } | null)?.then === "function") {
      throw new Error(
        `The build of "${label}" returned a promise. build is synchronous, so it can't do I/O: fetch in resolve, and build from what it returns.`,
      );
    }
    return built;
  };
}

export function publicResolveContext(ctx: InternalResolveContext): ResolveContext {
  return {
    abortSignal: ctx.abortSignal,
    channel: ctx.channel,
    session: ctx.session,
    ...(ctx.conversation === undefined ? {} : { conversation: ctx.conversation }),
  };
}
