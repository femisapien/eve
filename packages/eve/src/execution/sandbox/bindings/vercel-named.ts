import type {
  SandboxProviderHandle,
  SandboxProviderSessionContext,
  SandboxPreparedArtifact,
} from "#shared/sandbox-provider.js";
import type {
  SandboxProviderNamedSessions,
  SandboxProviderTag,
} from "#execution/sandbox/named-sessions.js";
import type { SandboxNetworkPolicy } from "#shared/sandbox-network-policy.js";
import type { SandboxSession } from "#shared/sandbox-session.js";
import type { VercelSandboxRuntimeOptions } from "#public/sandbox/vercel-sandbox.js";
import { ensureVercelSandboxBaseRuntime } from "#execution/sandbox/bindings/vercel-base-runtime.js";
import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import { isVercelSnapshotUnavailableError } from "#execution/sandbox/bindings/vercel-errors.js";
import {
  deleteUnusableVercelSandbox,
  deleteVercelSandbox,
} from "#execution/sandbox/bindings/vercel-lifecycle.js";
import type { VercelSandboxPreparedArtifact } from "#execution/sandbox/bindings/vercel.js";
import { getNamedVercelSandbox } from "#execution/sandbox/bindings/vercel-lookup.js";
import type {
  VercelCreateOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

type NetworkPolicySandboxSession = SandboxSession & {
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
};
type Handle = SandboxProviderHandle<NetworkPolicySandboxSession>;

/**
 * Vercel sandboxes addressed by name for tool sessions. `create` never looks up
 * first (`createOnly`), so a lost race surfaces as a name conflict (409) that
 * the caller resolves by finding the winner. Stopped persistent sandboxes
 * resume from their snapshot on the first command.
 */
export function createVercelNamedSessions(deps: {
  readonly createHandle: (sandbox: VercelSandbox) => Handle;
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelModule>;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly openSession: (
    context: SandboxProviderSessionContext,
    options: Readonly<VercelSandboxRuntimeOptions> | undefined,
    artifact: SandboxPreparedArtifact,
    sandboxName: string,
    named: { readonly tag: SandboxProviderTag },
  ) => Promise<Handle>;
}): SandboxProviderNamedSessions<
  VercelSandboxRuntimeOptions,
  VercelSandboxPreparedArtifact,
  NetworkPolicySandboxSession
> {
  return {
    async create(context, options, artifact, { name, tag }) {
      return await deps.openSession(context, options, artifact, name, { tag });
    },
    async delete(_context, { name }, condition) {
      const sandbox = await getNamedVercelSandbox({
        createOptions: deps.createOptions,
        sandboxModule: await deps.loadSandboxModule(),
        sandboxName: name,
      });
      if (sandbox === null) return false;
      const keep =
        condition === undefined
          ? undefined
          : (current: VercelSandbox) =>
              isRunningStatus(current.status) ||
              vercelLastUsedAt(current) >= condition.idleBefore ||
              condition.inUse?.() === true;
      // An early out; the check that counts runs on the final lookup, right before the request.
      if (keep?.(sandbox) === true) return false;
      return await deleteVercelSandbox({
        createOptions: deps.createOptions,
        keep,
        loadDeleteSandboxModule: deps.loadDeleteSandboxModule,
        sandbox,
      });
    },
    async find(_context, _artifact, { name }) {
      const sandboxModule = await deps.loadSandboxModule();
      const sandbox = await getNamedVercelSandbox({
        createOptions: deps.createOptions,
        sandboxModule,
        sandboxName: name,
      });
      if (sandbox === null) return null;
      const running = isRunningStatus(sandbox.status);
      try {
        // Running a command resumes a stopped persistent sandbox from its snapshot.
        await ensureVercelSandboxBaseRuntime(sandbox);
      } catch (error) {
        if (!isVercelSnapshotUnavailableError(error)) throw error;
        // Its snapshot expired: discard it so the caller creates a fresh one.
        await deleteUnusableVercelSandbox({
          createOptions: deps.createOptions,
          loadDeleteSandboxModule: deps.loadDeleteSandboxModule,
          sandbox,
        });
        return null;
      }
      return {
        handle: deps.createHandle(sandbox),
        running,
      };
    },
    async list(_context, tag) {
      const sandboxModule = await deps.loadSandboxModule();
      const credentials = await getVercelSandboxCredentials(deps.createOptions);
      const listed = await sandboxModule.Sandbox.list({
        ...credentials,
        fetch: getVercelSandboxFetch(deps.createOptions),
        // The SDK types a single-tag filter by literal key; the key here is a runtime value.
        tags: { [tag.key]: tag.value } as Record<"tag", string>,
      });
      const summaries = [];
      for await (const sandbox of listed) {
        summaries.push({
          lastUsedAt: Math.max(sandbox.updatedAt, sandbox.statusUpdatedAt ?? 0),
          name: sandbox.name,
          running: isRunningStatus(sandbox.status),
        });
      }
      return summaries;
    },
  };
}

function isRunningStatus(status: string): boolean {
  return status === "running" || status === "pending";
}

function vercelLastUsedAt(sandbox: VercelSandbox): number {
  return Math.max(toEpochMs(sandbox.updatedAt), toEpochMs(sandbox.statusUpdatedAt));
}

// The SDK types these as Dates; tolerate epoch numbers from older responses.
function toEpochMs(value: Date | number | undefined): number {
  if (value === undefined) return 0;
  return typeof value === "number" ? value : value.getTime();
}
