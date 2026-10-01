import type {
  ErasedSandboxProviderImplementation,
  SandboxPreparedArtifact,
  SandboxProviderHandle,
  SandboxProviderHost,
  SandboxProviderImplementation,
  SandboxProviderSessionContext,
} from "#shared/sandbox-provider.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

/*
 * Named sandbox sessions are internal to eve's own bindings for now: they back
 * tool-session sandbox reuse and are kept off the public
 * `SandboxProviderImplementation` so third-party providers see no API change.
 * A binding opts in with `withNamedSandboxSessions(implementation, named)`.
 */

/** Where a provider keeps sandboxes it can look up by name outside any session. */
export interface SandboxProviderStorageContext {
  readonly host: SandboxProviderHost;
  readonly storagePath: string;
}

/** One `{ key: value }` tag attached to a named sandbox. */
export interface SandboxProviderTag {
  readonly key: string;
  readonly value: string;
}

/** A sandbox name and the tag every sandbox under that name carries. */
export interface SandboxProviderNamedAddress {
  readonly name: string;
  readonly tag: SandboxProviderTag;
}

/** A named sandbox found by {@link SandboxProviderNamedSessions.find}. */
export interface SandboxProviderNamedSession<Session extends SandboxSession = SandboxSession> {
  readonly handle: SandboxProviderHandle<Session>;
  /** Whether the sandbox was already running, rather than resumed from its stopped state. */
  readonly running: boolean;
}

/** A named sandbox listed by {@link SandboxProviderNamedSessions.list}. */
export interface SandboxProviderNamedSessionSummary {
  /** Epoch milliseconds of the sandbox's most recent use. */
  readonly lastUsedAt: number;
  readonly name: string;
  readonly running: boolean;
}

/** Keeps a named sandbox that is still in use; see {@link SandboxProviderNamedSessions.delete}. */
export interface SandboxProviderNamedDeleteCondition {
  /** Epoch milliseconds; a sandbox used at or after this is kept. */
  readonly idleBefore: number;
  /** Asked last, right before the delete; `true` keeps the sandbox. */
  readonly inUse?: () => boolean;
}

/**
 * Sandboxes addressed by a caller-chosen name instead of persisted session
 * state. Tool sessions keep no record, so every call finds its sandbox by name.
 *
 * `create` must fail with {@link SandboxNameConflictError} when another caller
 * created the name first; eve then finds and reuses that sandbox.
 */
export interface SandboxProviderNamedSessions<
  OpenOptions extends object | undefined,
  PreparedArtifact extends SandboxPreparedArtifact,
  Session extends SandboxSession = SandboxSession,
> {
  create(
    context: SandboxProviderSessionContext,
    options: Readonly<OpenOptions> | undefined,
    artifact: Readonly<PreparedArtifact>,
    input: SandboxProviderNamedAddress,
  ): Promise<SandboxProviderHandle<Session>>;
  /**
   * Deletes the named sandbox. With `condition`, the provider re-reads the
   * sandbox immediately before deleting and keeps it, returning `false`, when
   * it is running, was used at or after `condition.idleBefore`, or
   * `condition.inUse()` says a call holds it, so a sweep
   * that listed it earlier does not delete one a call has since resumed.
   * Returns whether a sandbox was deleted.
   */
  delete(
    context: SandboxProviderStorageContext,
    input: SandboxProviderNamedAddress,
    condition?: SandboxProviderNamedDeleteCondition,
  ): Promise<boolean>;
  find(
    context: SandboxProviderSessionContext,
    artifact: Readonly<PreparedArtifact>,
    input: SandboxProviderNamedAddress,
  ): Promise<SandboxProviderNamedSession<Session> | null>;
  list(
    context: SandboxProviderStorageContext,
    tag: SandboxProviderTag,
  ): Promise<readonly SandboxProviderNamedSessionSummary[]>;
}

/** Thrown by a named `create` when a sandbox with that name already exists. */
export class SandboxNameConflictError extends Error {
  readonly sandboxName: string;

  constructor(sandboxName: string, options?: ErrorOptions) {
    super(`A sandbox named "${sandboxName}" already exists.`, options);
    this.name = "SandboxNameConflictError";
    this.sandboxName = sandboxName;
  }
}

export function isSandboxNameConflictError(error: unknown): error is SandboxNameConflictError {
  return error instanceof Error && error.name === "SandboxNameConflictError";
}

const namedSessions = new WeakMap<object, SandboxProviderNamedSessions<any, any, any>>();

/** Attaches name-addressed sessions to a provider implementation and returns it. */
export function withNamedSandboxSessions<
  OpenOptions extends object | undefined,
  PreparedArtifact extends SandboxPreparedArtifact,
  SessionState,
  Session extends SandboxSession,
>(
  implementation: SandboxProviderImplementation<
    OpenOptions,
    PreparedArtifact,
    SessionState,
    Session
  >,
  named: SandboxProviderNamedSessions<OpenOptions, PreparedArtifact, Session>,
): SandboxProviderImplementation<OpenOptions, PreparedArtifact, SessionState, Session> {
  namedSessions.set(implementation, named);
  return implementation;
}

/** The implementation's name-addressed sessions, when its binding supports them. */
export function getNamedSandboxSessions(
  implementation: ErasedSandboxProviderImplementation,
): SandboxProviderNamedSessions<object | undefined, SandboxPreparedArtifact> | undefined {
  return namedSessions.get(implementation);
}
