import type { ModelMessage } from "ai";

import type { SessionAuth, SessionPredecessor } from "#context/keys.js";
import type { SessionSchedule } from "#context/session-schedule.js";
import type { UserPart } from "#protocol/session-events/envelope.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { stampDefinitionKey } from "#internal/authored-definition/source-identity.js";
import type { ConversationContext } from "#shared/conversation-context.js";

/**
 * The session's latest turn, running or not. Select its `id` to resolve once per turn: it stays
 * the same through the turn's tool calls, pauses, and steering, and until the next turn starts.
 */
export interface ReactionTurn {
  readonly id: string;
  readonly status: "running" | "paused" | "settled";
  /**
   * What started the turn: the parts of the messages it opened with. Messages that steer it
   * later don't change them.
   */
  readonly input: readonly UserPart[];
}

/**
 * What a reaction selects from: the session's tables, the position of the latest event of each
 * type, the latest turn, the effective model, and the conversation.
 *
 * `messages` is the conversation as the model sees it. Steps that run without the conversation,
 * such as a task settling between turns, skip a reaction whose `select` reads it; the reaction runs
 * again after the next commit that has it.
 */
export interface ReactionView extends SessionView {
  /** The line position of the latest event of each type, and `"*"` for the latest fact. */
  readonly latest: Readonly<Record<string, number | undefined>>;
  /** The session's latest turn, or `null` before its first. */
  readonly turn: ReactionTurn | null;
  /** The model the session uses now, or `null` before one is chosen. */
  readonly model: { readonly id: string } | null;
  readonly messages: readonly ModelMessage[];
}

/** The session's identity, auth, and channel, for `select` and `resolve`. */
export interface SelectContext {
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
    readonly schedule?: SessionSchedule;
    /**
     * Present when eve started this session in place of a stranded session,
     * one that another eve version built. It names the earlier session, whose recorded stream
     * `sessions.attach(predecessor.sessionId)` from `eve/server` reads.
     */
    readonly predecessor?: SessionPredecessor;
  };
  readonly channel: {
    /** Channel type that produced the request (e.g. `"slack"`, `"http"`), when known. */
    readonly kind?: string;
    /** Channel-owned resume handle for the conversation, when the channel supplies one. */
    readonly continuationToken?: string;
    /** Free-form channel-specific metadata attached to the request. */
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  /** Classification and execution context for the active conversation, when known. */
  readonly conversation?: ConversationContext;
}

/**
 * What `resolve` receives besides its selection. eve calls `resolve` once for each new selection
 * and records what it returns, so it gets no facts. Read facts in a hook's `events` handlers.
 */
export interface ResolveContext extends SelectContext {
  readonly abortSignal: AbortSignal;
}

/** Reads what a reaction depends on. Synchronous and deterministic; returns JSON. */
export type ReactionSelect<TSelected, TView = ReactionView> = (
  view: TView,
  ctx: SelectContext,
) => TSelected;

/** Fetches what a value is made of, given what its `select` read. eve records the result. */
export type ReactionResolve<TSelected, TResult> = (
  selected: TSelected,
  ctx: ResolveContext,
) => TResult | Promise<TResult>;

/**
 * Creates the code a value carries, such as tools, from the JSON eve recorded: what `resolve`
 * returned, or the selection when there's no `resolve`. Synchronous, so it can't do I/O. A process
 * that has never seen the session calls it with the recorded JSON, and never calls `resolve`.
 */
export type ReactionBuild<TInput, TResult> = (input: TInput) => TResult;

/** Resolves once per session: `select: once`. */
export const once = (): null => null;

/** Resolves once per turn: `select: perTurn`. */
export const perTurn = (view: { readonly turn: { readonly id: string } | null }): string | null =>
  view.turn?.id ?? null;

/** Resolves once per model call: `select: perStep`. */
export const perStep = (view: {
  readonly latest: Readonly<Record<string, number | undefined>>;
}): number | null => view.latest["model.requested"] ?? null;

/** Marker discriminator for a `defineDynamic()` or `defineHook()` export. */
export const DYNAMIC_SENTINEL_KIND = "eve:dynamic" as const;

/** A `defineDynamic()` export, which the compiler detects by its `kind`. */
export interface DynamicSentinel<TResult = unknown, TSelected = unknown> {
  readonly kind: typeof DYNAMIC_SENTINEL_KIND;
  readonly select: ReactionSelect<TSelected>;
  readonly resolve?: ReactionResolve<TSelected, unknown>;
  readonly build?: ReactionBuild<never, TResult>;
}

/** A value that is data: `resolve` returns it. */
export interface DynamicDataDefinition<TSelected, TResult> {
  readonly select: ReactionSelect<TSelected>;
  readonly resolve: ReactionResolve<TSelected, TResult>;
  readonly build?: never;
}

/** A value with code that needs I/O: `resolve` fetches JSON, and `build` creates the code. */
export interface DynamicFetchedCodeDefinition<TSelected, TData, TResult> {
  readonly select: ReactionSelect<TSelected>;
  readonly resolve: ReactionResolve<TSelected, TData>;
  readonly build: ReactionBuild<TData, TResult>;
}

/** A value with code and no I/O: `build` creates it from the selection. */
export interface DynamicSelectedCodeDefinition<TSelected, TResult> {
  readonly select: ReactionSelect<TSelected>;
  readonly resolve?: never;
  readonly build: ReactionBuild<TSelected, TResult>;
}

/** `defineDynamic()` for a slot whose value may be data or code: instructions, skills, models. */
export interface DefineDynamic<TResult> {
  <TSelected, TData, TStatic extends object = object>(
    definition: DynamicFetchedCodeDefinition<TSelected, TData, TResult> & TStatic,
  ): DynamicSentinel<TResult, TSelected> & TStatic;
  <TSelected, TStatic extends object = object>(
    definition: DynamicSelectedCodeDefinition<TSelected, TResult> & TStatic,
  ): DynamicSentinel<TResult, TSelected> & TStatic;
  <TSelected, TStatic extends object = object>(
    definition: DynamicDataDefinition<TSelected, TResult> & TStatic,
  ): DynamicSentinel<TResult, TSelected> & TStatic;
}

/** `defineDynamic()` for a slot whose value is always code, tools and connections: `build` makes it. */
export interface DefineDynamicCode<TResult> {
  <TSelected, TData, TStatic extends object = object>(
    definition: DynamicFetchedCodeDefinition<TSelected, TData, TResult> & TStatic,
  ): DynamicSentinel<TResult, TSelected> & TStatic;
  <TSelected, TStatic extends object = object>(
    definition: DynamicSelectedCodeDefinition<TSelected, TResult> & TStatic,
  ): DynamicSentinel<TResult, TSelected> & TStatic;
}

/**
 * The one definition every authored reaction compiles from: `select` with `resolve` or `build`,
 * or a map of `events` handlers. `defineDynamic()` and `defineHook()` narrow it.
 */
export type ResolverDefinition =
  | {
      readonly select: (...args: never[]) => unknown;
      readonly resolve?: (...args: never[]) => unknown;
      readonly build?: (...args: never[]) => unknown;
      readonly events?: never;
    }
  | {
      readonly events: Readonly<Record<string, unknown>>;
      readonly select?: never;
      readonly resolve?: never;
      readonly build?: never;
    };

/** Validates a resolver's form and marks it for the compiler. Not public: use its narrowings. */
export function defineResolver<T extends ResolverDefinition>(
  definition: T,
  name: string,
  options: ResolverFormOptions = {},
): T & { readonly kind: typeof DYNAMIC_SENTINEL_KIND } {
  assertResolverForm(definition, `${name}()`, options);
  const sentinel = { ...definition, kind: DYNAMIC_SENTINEL_KIND };
  stampDefinitionKey(sentinel, "dynamic");
  return sentinel;
}

/** A hook's form: `events`, or `select` and `resolve`. Hooks act, so they have nothing to build. */
export const HOOK_FORM: ResolverFormOptions = { build: "forbidden", events: true };

export interface ResolverFormOptions {
  /** Whether an `events` map is allowed instead of `select`. Hooks only. */
  readonly events?: boolean;
  /** Whether `build` is required (tools, connections), allowed (the default), or forbidden (hooks). */
  readonly build?: "required" | "allowed" | "forbidden";
}

/**
 * Throws unless `value` takes one form: `select` with `resolve`, `build`, or both, or an `events`
 * object. The definers, the compiler, and the runtime loader all use it, so every source agrees.
 */
export function assertResolverForm(
  value: unknown,
  subject: string,
  options: ResolverFormOptions = {},
): void {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${subject} takes an object.`);
  }
  const { build, events, resolve, select } = value as Record<string, unknown>;
  if (events !== undefined) {
    if (options.events !== true) {
      throw new Error(`${subject} takes select with resolve or build, not events.`);
    }
    if (select !== undefined || resolve !== undefined || build !== undefined) {
      throw new Error(`${subject} takes either events or select and resolve, not both.`);
    }
    if (typeof events !== "object" || events === null) {
      throw new Error(`${subject} events must be an object of handlers.`);
    }
    return;
  }
  if (resolve !== undefined && typeof resolve !== "function") {
    throw new Error(`${subject} resolve must be a function.`);
  }
  if (build !== undefined && typeof build !== "function") {
    throw new Error(`${subject} build must be a function.`);
  }
  const mode = options.build ?? "allowed";
  if (mode === "forbidden" && build !== undefined) {
    throw new Error(`${subject} takes select and resolve; only dynamic values take build.`);
  }
  if (mode === "required" && build === undefined) {
    throw new Error(
      `${subject} creates code, so it needs build: return JSON from resolve, and create the code from it in build. eve records the JSON, and a fresh process calls build with it.`,
    );
  }
  if (resolve === undefined && build === undefined) {
    throw new Error(
      options.events === true
        ? `${subject} requires events, or select and resolve.`
        : `${subject} requires resolve or build beside select.`,
    );
  }
  if (typeof select !== "function") {
    throw new Error(
      `${subject} requires a select function. Use select: once to resolve once per session.`,
    );
  }
}

/**
 * Defines a value that depends on the session. `select` reads what it depends on; `resolve`
 * fetches what it's made of, once per new selection, and eve records that; `build` creates any
 * code it carries from the recorded JSON. The directory decides what the value is: tools in
 * `agent/tools/`, skills in `agent/skills/`, and so on.
 *
 * ```ts
 * import { defineDynamic, defineTool, once } from "eve/tools";
 *
 * export default defineDynamic({
 *   select: once,
 *   resolve: async () => (await listTables()).map(({ name, columns }) => ({ name, columns })),
 *   build: (tables) => Object.fromEntries(tables.map((table) => [table.name, tableTool(table)])),
 * });
 * ```
 */
export const defineDynamic: DefineDynamic<unknown> = ((definition: ResolverDefinition) =>
  defineResolver(definition, "defineDynamic")) as DefineDynamic<unknown>;

const FRAMEWORK_RESOLVER = Symbol.for("eve.framework-resolver");

/**
 * Marks a definition eve generates, such as a memory slot's tools: its `resolve` runs in the
 * session's context with eve's own resolve context, as eve's internal reactions do.
 */
export function asFrameworkResolver<T extends object>(definition: T): T {
  Object.defineProperty(definition, FRAMEWORK_RESOLVER, { value: true });
  return definition;
}

export function isFrameworkResolver(value: unknown): boolean {
  return typeof value === "object" && value !== null && FRAMEWORK_RESOLVER in value;
}

export function isDynamicSentinel(value: unknown): value is DynamicSentinel {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === DYNAMIC_SENTINEL_KIND
  );
}

/** Rejects keys a slot doesn't accept beside `select`, `resolve`, and `build`. */
export function assertDynamicSentinelKeys(
  sentinel: DynamicSentinel,
  message: string,
  allowed: readonly string[] = [],
): void {
  assertResolverForm(sentinel, `${message} The definition`);
  const unknownKeys = Object.keys(sentinel).filter(
    (key) =>
      key !== "kind" &&
      key !== "select" &&
      key !== "resolve" &&
      key !== "build" &&
      !allowed.includes(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`${message} Unknown key(s): ${unknownKeys.join(", ")}.`);
  }
}
