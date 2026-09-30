import { getNamedSandboxSessions } from "#execution/sandbox/named-sessions.js";
import { createHash } from "node:crypto";

import type { InvokeToolSandboxReport } from "#channel/invoke-tool.js";
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
  isSandboxNameConflictError,
  type SandboxProviderNamedSession,
  type SandboxProviderTag,
} from "#execution/sandbox/named-sessions.js";

const log = createLogger("tool-session.sandbox");

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tag on every tool-session sandbox, `eve:tool-session`, so the sweep can find them. */
export const TOOL_SESSION_SANDBOX_TAG: SandboxProviderTag = { key: "eve", value: "tool-session" };

/** Default idle time after which the sweep deletes a tool-session sandbox (Vercel's snapshot expiry). */
export const TOOL_SESSION_SANDBOX_EXPIRY_MS = 30 * DAY_MS;

/** How often {@link sweepToolSessionSandboxes} is meant to run. */
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

/**
 * Finds the named sandbox, or creates it. Creation races across instances
 * because a provider's get-then-create is not atomic, so a create that fails
 * with a name conflict looks the name up again and reuses the winner.
 */
export const startNamedToolSessionSandbox =
  (onState: (state: OpenedState) => void): SandboxStartOverride =>
  async ({ artifact, context, options, provider }) => {
    const named = getNamedSandboxSessions(provider.implementation);
    if (named === undefined) {
      // No named lookup: the sandbox cannot be found again, so it lives for this call only.
      const started = await provider.implementation.start(context, options, artifact);
      onState("created");
      return { created: true, handle: withCallScopedLifetime(started.handle) };
    }
    const name = toolSessionSandboxName({
      artifact,
      providerName: provider.providerName,
      sessionId: context.session.id,
    });
    const address = { name, tag: TOOL_SESSION_SANDBOX_TAG };
    const found = await named.find(context, artifact, address);
    if (found !== null) return reuse(found, onState);
    try {
      const handle = await named.create(context, options, artifact, address);
      onState("created");
      return { created: true, handle };
    } catch (error) {
      if (!isSandboxNameConflictError(error)) throw error;
      const winner = await named.find(context, artifact, address);
      if (winner === null) {
        throw new Error(
          `Sandbox "${name}" reported a name conflict, but no sandbox with that name exists.`,
          { cause: error },
        );
      }
      return reuse(winner, onState);
    }
  };

function reuse(found: SandboxProviderNamedSession, onState: (state: OpenedState) => void) {
  onState(found.running ? "reused" : "resumed");
  return { created: false, handle: found.handle };
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
  /** Deletes the sandbox if this call opened one that must not outlive it. */
  release(input: { readonly oneOff: boolean }): Promise<void>;
  /** Present once the call opened the sandbox. */
  report(): InvokeToolSandboxReport | undefined;
}

/**
 * Lazily opens a tool session's sandbox on the first `ctx.getSandbox()`. Tools
 * that never call it start nothing.
 */
export async function createToolSessionSandbox(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly registry: RuntimeSandboxRegistry;
  readonly sessionId: string;
}): Promise<ToolSessionSandbox> {
  let state: OpenedState | undefined;
  let report: InvokeToolSandboxReport | undefined;
  let callScoped = false;
  const inner = await ensureSandboxAccess({
    compiledArtifactsSource: input.compiledArtifactsSource,
    nodeId: input.nodeId,
    ownsSandbox: true,
    registry: input.registry,
    sessionId: input.sessionId,
    startSandbox: async (start) => {
      const started = await startNamedToolSessionSandbox((value) => {
        state = value;
      })(start);
      callScoped = callScopedHandles.has(started.handle);
      return started;
    },
    state: null,
  });

  let opening: Promise<SandboxSession | null> | undefined;
  // Whether this call holds an open sandbox the tool has not deleted itself.
  let live = false;
  const access: SandboxAccess = {
    ...inner,
    get() {
      if (opening === undefined) {
        const startedAt = performance.now();
        const attempt = inner.get().then((sandbox) => {
          if (sandbox !== null && state !== undefined) {
            report = { ms: Math.round(performance.now() - startedAt), state };
            live = true;
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
    async delete(options) {
      await inner.delete?.(options);
      opening = undefined;
      live = false;
    },
  };

  return {
    access,
    async release({ oneOff }) {
      if (!live || (!oneOff && !callScoped)) return;
      live = false;
      await inner.delete?.();
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
 * retention. Meant to run every {@link TOOL_SESSION_SANDBOX_SWEEP_INTERVAL_MS}.
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
    if (summary.running || summary.lastUsedAt >= cutoff) continue;
    try {
      await named.delete(context, { name: summary.name, tag: TOOL_SESSION_SANDBOX_TAG });
      deleted.push(summary.name);
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
