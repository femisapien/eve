import type { ModelMessage } from "ai";

import type { SessionEvent } from "#protocol/session-event.js";

import { runOnSelection, type ContextContainer } from "#context/container.js";
import type { ReactionView, RecordContext, SelectContext } from "#dynamic/definition.js";
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

/** What eve's own reactions receive besides the public {@link RecordContext}. */
export interface InternalRecordContext extends RecordContext {
  readonly ctx: ContextContainer;
  /** The commit's records with their positions, empty when a fresh process renders again. */
  readonly written: readonly WrittenEvent[];
  /** The commit's events, for eve's own effects; authored `record` never sees them. */
  readonly facts: readonly SessionEvent[];
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
  readonly record?: (selected: unknown, ctx: InternalRecordContext) => unknown;
  /**
   * Renders the value from what was recorded: `record`'s result, or the selection. A process that
   * didn't render it renders again from the recorded JSON; nothing records again for a selection
   * already recorded. Without it, what `record` returned is the value.
   */
  readonly render?: (input: JsonValue, ctx: InternalRecordContext) => unknown;
  /** Validates and names the value. Throws on a value the kind can't read. */
  readonly contribute: (
    result: unknown,
    ctx: InternalRecordContext,
  ) => Contribution | Promise<Contribution>;
  /** A failure fails the commit instead of withdrawing the slot. */
  readonly failure?: "throw";
}

/** The bundle's reactions in run order, and what each kind does once its slots change. */
export interface BundleReactions {
  readonly reactions: readonly Reaction[];
  readonly effects: Partial<Record<ReactionKind, (ctx: ContextContainer) => Promise<void>>>;
}

/**
 * An authored `record` as a reaction's: it runs outside the session's context and gets only the
 * public {@link RecordContext}, so only its selection is watched.
 */
export function authoredRecord(
  label: string,
  record: ((selected: never, ctx: never) => unknown) | undefined,
  options: { readonly framework?: boolean } = {},
): Reaction["record"] {
  if (record === undefined) return undefined;
  if (options.framework === true) return record as Reaction["record"];
  return (selected, ctx) =>
    runOnSelection(label, () => record(selected as never, publicRecordContext(ctx) as never));
}

/**
 * An authored `render` as a reaction's: synchronous, outside the session's context, and given only
 * what was recorded. eve's own renders, such as a memory slot's tools, run in context and may wait.
 */
export function authoredRender(
  label: string,
  render: ((input: never, ctx: never) => unknown) | undefined,
  options: { readonly framework?: boolean } = {},
): Reaction["render"] {
  if (render === undefined) return undefined;
  if (options.framework === true) return render as Reaction["render"];
  return (input) => {
    const rendered = runOnSelection(label, () => render(input as never, undefined as never));
    if (typeof (rendered as { then?: unknown } | null)?.then === "function") {
      throw new Error(
        `The render of "${label}" returned a promise. render is synchronous, so it can't do I/O: fetch in record, and render from what it returns.`,
      );
    }
    return rendered;
  };
}

/**
 * The public part of a record context. `messages` stays a lazy getter, so a commit without the
 * conversation postpones only a `record` that reads it.
 */
export function publicRecordContext(ctx: InternalRecordContext): RecordContext {
  return withMessages(
    {
      abortSignal: ctx.abortSignal,
      channel: ctx.channel,
      session: ctx.session,
      ...(ctx.conversation === undefined ? {} : { conversation: ctx.conversation }),
    },
    () => ctx.messages,
  );
}

/** Adds `messages` as a lazy, non-enumerable getter, so spreading a context doesn't read it. */
export function withMessages<T extends object>(
  target: T,
  read: () => readonly ModelMessage[],
): T & { readonly messages: readonly ModelMessage[] } {
  Object.defineProperty(target, "messages", { enumerable: false, get: read });
  return target as T & { readonly messages: readonly ModelMessage[] };
}
