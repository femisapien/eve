import { createHash, randomBytes } from "node:crypto";

import type { InvokeToolSandboxReport } from "#channel/invoke-tool.js";
import { untrackActiveSandboxHandle } from "#execution/sandbox/active-handles.js";
import { ensureSandboxAccess, type SandboxStartOverride } from "#execution/sandbox/ensure.js";
import { createSandboxProviderHost } from "#execution/sandbox/provider-host.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import { createLogger } from "#internal/logging.js";
import {
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { SandboxAccess } from "#sandbox/state.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import { getSandboxEnvironmentRuntime } from "#shared/sandbox-environment.js";
import {
  type SandboxPreparedArtifact,
  type SandboxProviderHandle,
} from "#shared/sandbox-provider.js";
import {
  getNamedSandboxSessions,
  isSandboxNameConflictError,
  type SandboxProviderNamedSession,
  type SandboxProviderTag,
} from "#execution/sandbox/named-sessions.js";
import { ToolSessionError } from "#shared/tool-session-error.js";

const log = createLogger("tool-session.sandbox");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tag on every tool-session sandbox, `eve:tool-session`, so the sweep can find them. */
export const TOOL_SESSION_SANDBOX_TAG: SandboxProviderTag = { key: "eve", value: "tool-session" };

/** Default idle time after which the sweep deletes a tool-session sandbox (Vercel's snapshot expiry). */
export const TOOL_SESSION_SANDBOX_EXPIRY_MS = 30 * DAY_MS;

/** How often {@link sweepToolSessionSandboxes} runs. */
export const TOOL_SESSION_SANDBOX_SWEEP_INTERVAL_MS = 7 * DAY_MS;

/**
 * Names a tool session's sandbox from its session id and the prepared sandbox
 * template, so a new template yields a new sandbox and the old one ages out.
 */
export function toolSessionSandboxName(input: {
  readonly artifact: SandboxPreparedArtifact;
  readonly providerName: string;
  readonly sessionId: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "eve.tool-session-sandbox.v1",
        input.providerName,
        input.sessionId,
        input.artifact,
      ]),
      "utf8",
    )
    .digest("hex");
  return `eve-ts-${digest.slice(0, 32)}`;
}

type OpenedState = InvokeToolSandboxReport["state"];

/** How long a tool session's sandbox must outlive the call. */
export type ToolSessionSandboxLifetime = "keyed" | "one-off";

/**
 * Raised when a keyed tool session opens a sandbox on a provider that cannot
 * find a sandbox again by name. Such a provider derives its sandbox from the
 * session id alone, so concurrent calls with one key would share a sandbox that
 * each call deletes when it ends. One-off sessions still work there.
 */
export class ToolSessionSandboxPersistenceError extends ToolSessionError {
  readonly providerName: string;

  constructor(providerName: string) {
    super(
      `Sandbox provider "${providerName}" cannot keep a sandbox between tool-session calls, ` +
        "so a tool session with a key cannot open one. Call without a key for a sandbox that " +
        "lasts one call, or use a provider with named sandboxes, such as Vercel Sandbox or just-bash.",
    );
    this.name = "ToolSessionSandboxPersistenceError";
    this.providerName = providerName;
  }
}

// Sandbox names held by in-flight calls in this process, with a holder count.
// The sweep skips them, and re-checks right before each delete.
const sandboxLeases = new Map<string, number>();

function acquireSandboxLease(name: string): () => void {
  sandboxLeases.set(name, (sandboxLeases.get(name) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const holders = (sandboxLeases.get(name) ?? 1) - 1;
    if (holders <= 0) sandboxLeases.delete(name);
    else sandboxLeases.set(name, holders);
  };
}

function isSandboxLeased(name: string): boolean {
  return sandboxLeases.has(name);
}

// Per-name lock that serializes, in this process, a call taking its lease with
// the sweep's delete of that name: a call admitted first holds the lease the
// delete checks last, and a call arriving mid-delete waits and then finds no
// sandbox, so it creates a fresh one instead of resuming one being deleted.
const sandboxNameLocks = new Map<string, Promise<void>>();

async function withSandboxNameLock<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = sandboxNameLocks.get(name) ?? Promise.resolve();
  let unlock!: () => void;
  const held = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const tail = previous.then(() => held);
  sandboxNameLocks.set(name, tail);
  await previous;
  try {
    return await fn();
  } finally {
    unlock();
    if (sandboxNameLocks.get(name) === tail) sandboxNameLocks.delete(name);
  }
}

interface NamedStartHooks {
  /** Takes this call's lease on a named sandbox before it is looked up. */
  readonly lease: (name: string) => Promise<void>;
  readonly onState: (state: OpenedState) => void;
}

/**
 * Finds the named sandbox, or creates it. Creation races across instances
 * because a provider's get-then-create is not atomic, so a create that fails
 * with a name conflict looks the name up again and reuses the winner.
 *
 * A one-off call's sandbox is private to the invocation: its name, or on a
 * provider without named lookup its session id, derives from
 * `isolatedSessionId`, never the logical session id that signed retries share.
 * So concurrent retries with one nonce never share a sandbox that the first to
 * finish deletes, and each is tracked for shutdown under its own identity. A
 * keyed session on a provider without named lookup fails with
 * {@link ToolSessionSandboxPersistenceError}.
 */
export const startNamedToolSessionSandbox =
  (
    hooks: NamedStartHooks,
    identity: { readonly isolatedSessionId: string; readonly lifetime: ToolSessionSandboxLifetime },
  ): SandboxStartOverride =>
  async ({ artifact, context, options, provider }) => {
    const oneOff = identity.lifetime === "one-off";
    const trackingId = oneOff ? identity.isolatedSessionId : undefined;
    const named = getNamedSandboxSessions(provider.implementation);
    if (named === undefined) {
      if (!oneOff) throw new ToolSessionSandboxPersistenceError(provider.providerName);
      const isolated = {
        ...context,
        session: { ...context.session, id: identity.isolatedSessionId },
      };
      const started = await provider.implementation.start(isolated, options, artifact);
      hooks.onState("created");
      return { created: true, handle: withCallScopedLifetime(started.handle), trackingId };
    }
    const name = toolSessionSandboxName({
      artifact,
      providerName: provider.providerName,
      sessionId: oneOff ? identity.isolatedSessionId : context.session.id,
    });
    await hooks.lease(name);
    const address = { name, tag: TOOL_SESSION_SANDBOX_TAG };
    const found = await named.find(context, artifact, address);
    if (found !== null) return reuse(found, hooks.onState, trackingId);
    try {
      const handle = await named.create(context, options, artifact, address);
      hooks.onState("created");
      return { created: true, handle, trackingId };
    } catch (error) {
      if (!isSandboxNameConflictError(error)) throw error;
      const winner = await named.find(context, artifact, address);
      if (winner === null) {
        throw new Error(
          `Sandbox "${name}" reported a name conflict, but no sandbox with that name exists.`,
          { cause: error },
        );
      }
      return reuse(winner, hooks.onState, trackingId);
    }
  };

function reuse(
  found: SandboxProviderNamedSession,
  onState: (state: OpenedState) => void,
  trackingId: string | undefined,
) {
  onState(found.running ? "reused" : "resumed");
  return { created: false, handle: found.handle, trackingId };
}

// Marks a handle whose sandbox must be deleted when the call ends.
const callScopedHandles = new WeakSet<SandboxProviderHandle>();

function withCallScopedLifetime(handle: SandboxProviderHandle): SandboxProviderHandle {
  callScopedHandles.add(handle);
  return handle;
}

/** Sandbox access for one tool call, plus what the call did with it. */
export interface ToolSessionSandbox {
  readonly access: SandboxAccess;
  /**
   * Ends the call's hold on its sandbox, and deletes the sandbox if it must not
   * outlive the call: a one-off session's, or a call-scoped fallback's.
   */
  release(): Promise<void>;
  /** Present once the call opened the sandbox. */
  report(): InvokeToolSandboxReport | undefined;
}

/**
 * Lazily opens a tool session's sandbox on the first `ctx.getSandbox()`. Tools
 * that never call it start nothing.
 */
export async function createToolSessionSandbox(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly lifetime: ToolSessionSandboxLifetime;
  readonly nodeId: string;
  readonly registry: RuntimeSandboxRegistry;
  readonly sessionId: string;
}): Promise<ToolSessionSandbox> {
  let state: OpenedState | undefined;
  let report: InvokeToolSandboxReport | undefined;
  let callScoped = false;
  let releaseLease: (() => void) | undefined;
  // The latest handle this call opened, kept so release can delete a stopped sandbox.
  let latest:
    | {
        readonly handle: SandboxProviderHandle;
        readonly providerName: string;
        readonly trackingId: string;
      }
    | undefined;
  // One isolated id per invocation, so reopening after stop() finds the same private sandbox.
  const isolatedSessionId = `${input.sessionId}.call-${randomBytes(8).toString("hex")}`;
  const inner = await ensureSandboxAccess({
    compiledArtifactsSource: input.compiledArtifactsSource,
    nodeId: input.nodeId,
    ownsSandbox: true,
    registry: input.registry,
    sessionId: input.sessionId,
    startSandbox: async (start) => {
      const started = await startNamedToolSessionSandbox(
        {
          lease: async (name) => {
            if (releaseLease !== undefined) return;
            await withSandboxNameLock(name, () => {
              releaseLease ??= acquireSandboxLease(name);
            });
          },
          onState: (value) => {
            state = value;
          },
        },
        { isolatedSessionId, lifetime: input.lifetime },
      )(start);
      callScoped = callScopedHandles.has(started.handle);
      latest = {
        handle: started.handle,
        providerName: start.provider.providerName,
        trackingId: started.trackingId ?? input.sessionId,
      };
      return started;
    },
    state: null,
  });

  let opening: Promise<SandboxSession | null> | undefined;
  // Whether this call opened a sandbox the tool has not deleted itself.
  let live = false;
  // Whether that sandbox is open now, rather than stopped by the tool.
  let open = false;
  const access: SandboxAccess = {
    ...inner,
    get() {
      if (opening === undefined) {
        const startedAt = performance.now();
        const attempt = inner.get().then((sandbox) => {
          if (sandbox !== null && state !== undefined) {
            report ??= { ms: Math.round(performance.now() - startedAt), state };
            live = true;
            open = true;
          }
          return sandbox;
        });
        opening = attempt;
        attempt.catch(() => {
          if (opening === attempt) opening = undefined;
        });
      }
      return opening;
    },
    async stop() {
      // The stopped session is unusable; the next get() reopens the sandbox.
      opening = undefined;
      open = false;
      await inner.stop();
    },
    async delete(options) {
      await inner.delete?.(options);
      opening = undefined;
      live = false;
      open = false;
    },
  };

  return {
    access,
    async release() {
      try {
        if (!live || (input.lifetime !== "one-off" && !callScoped)) return;
        live = false;
        if (open) {
          open = false;
          await inner.delete?.();
          return;
        }
        // Stopped by the tool: delete through the last handle instead of reopening it.
        if (latest === undefined) return;
        await latest.handle.onSessionDelete();
        untrackActiveSandboxHandle({
          handle: latest.handle,
          providerName: latest.providerName,
          sessionId: latest.trackingId,
        });
      } finally {
        releaseLease?.();
      }
    },
    report: () => report,
  };
}

/** Result of one {@link sweepToolSessionSandboxes} pass. */
export interface ToolSessionSandboxSweepResult {
  readonly deleted: readonly string[];
  readonly failed: readonly string[];
  /** Set when the provider cannot list named sandboxes, so nothing was swept. */
  readonly skipped?: string;
}

/**
 * Deletes tool-session sandboxes unused for longer than `expiryMs` (30 days by
 * default). A tool session has no end to delete its sandbox, so this bounds
 * retention. Production builds schedule it weekly as the
 * `eve.tool-session-sandbox-sweep` Nitro task.
 *
 * In this process, a per-name lock serializes each delete with calls taking
 * their lease, and the provider checks the lease, running state and last use
 * at its final lookup, right before the delete request, so an admitted call's
 * sandbox is never deleted.
 *
 * Across instances this is NOT atomic: there is no lease the sweep can see,
 * only the provider's final re-read. A call on another instance that resumes a
 * 30-day-idle sandbox between that re-read and the delete request can still
 * lose it, and then fails as it would after expiry.
 */
export async function sweepToolSessionSandboxes(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly expiryMs?: number;
  readonly now?: number;
  readonly registry: RuntimeSandboxRegistry;
}): Promise<ToolSessionSandboxSweepResult> {
  const definition = input.registry.sandbox?.definition;
  if (definition?.kind !== "independent") {
    return { deleted: [], failed: [], skipped: "The agent has no sandbox of its own." };
  }
  const provider = getSandboxEnvironmentRuntime(definition.environment);
  const named = getNamedSandboxSessions(provider.implementation);
  if (named === undefined) {
    return {
      deleted: [],
      failed: [],
      skipped: `Sandbox provider "${provider.providerName}" cannot list sandboxes by tag.`,
    };
  }
  const appRoot =
    getRuntimeCompiledArtifactsSandboxAppRoot(input.compiledArtifactsSource) ?? process.cwd();
  const context = {
    host: createSandboxProviderHost(appRoot),
    storagePath: resolveSandboxCacheDirectory(appRoot),
  };
  const cutoff = (input.now ?? Date.now()) - (input.expiryMs ?? TOOL_SESSION_SANDBOX_EXPIRY_MS);
  const deleted: string[] = [];
  const failed: string[] = [];
  for (const summary of await named.list(context, TOOL_SESSION_SANDBOX_TAG)) {
    if (summary.running || summary.lastUsedAt >= cutoff || isSandboxLeased(summary.name)) continue;
    try {
      // The listing may be stale by now: a call can have resumed the sandbox since.
      // The provider re-reads it right before deleting, and the lease is checked
      // again at that point, so a sandbox a call holds or has just used is kept.
      const removed = await withSandboxNameLock(summary.name, () =>
        named.delete(
          context,
          { name: summary.name, tag: TOOL_SESSION_SANDBOX_TAG },
          { idleBefore: cutoff, inUse: () => isSandboxLeased(summary.name) },
        ),
      );
      if (removed) deleted.push(summary.name);
    } catch (error) {
      failed.push(summary.name);
      log.warn("failed to delete an expired tool-session sandbox", {
        error: error instanceof Error ? error.message : String(error),
        sandboxName: summary.name,
      });
    }
  }
  return { deleted, failed };
}
