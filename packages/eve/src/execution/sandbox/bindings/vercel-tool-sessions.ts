import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import { isVercelSnapshotNotFoundError } from "#execution/sandbox/bindings/vercel-errors.js";
import type {
  VercelCreateOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

/**
 * How long a tool session's saved filesystem outlives its last use. It is
 * also the shortest `snapshotExpiration` the Sandbox API accepts.
 */
export const VERCEL_TOOL_SESSION_SNAPSHOT_EXPIRATION_MS = 24 * 60 * 60 * 1000;

/*
 * A tool session has no end to delete its sandbox at, so Vercel expires it:
 * the sandbox's snapshots expire a day after their last use (each resume
 * restarts that day), and only the latest is kept. These options apply when
 * the sandbox is created, so they do not change its name.
 */
export function withToolSessionRetention(options: VercelCreateOptions): VercelCreateOptions {
  return {
    ...options,
    keepLastSnapshots: { count: 1 },
    snapshotExpiration: VERCEL_TOOL_SESSION_SNAPSHOT_EXPIRATION_MS,
  };
}

// Attempts to move past expired generations before giving up.
const MAX_TOOL_SESSION_GENERATIONS = 3;

/**
 * Opens a tool session's sandbox, moving on to a new one once Vercel has
 * expired its snapshot.
 *
 * Another instance may see the same expiry, so the expired sandbox is never
 * deleted to free its name: a late delete by name would remove the
 * replacement an instance just made. Each replacement takes the next
 * generation's name (`<base>`, then `<base>-1`, `<base>-2`, ...) instead, and
 * the provider's name uniqueness picks one: `open` creates the name or adopts
 * the sandbox that won it. An expired generation cannot resume again, and
 * Vercel removes it.
 *
 * Only a name past the listed generations is ever created. A listed
 * generation that is gone by the time it is opened was removed after expiry,
 * so it is retired: recreating its name would fork the session away from the
 * successor other instances use. Vercel removes a sandbox only well after its
 * creation, so a generation the listing does not show was never retired.
 */
export async function openToolSessionGeneration<Session extends { readonly created: boolean }>(
  input: {
    readonly baseName: string;
    readonly createOptions: VercelCreateOptions;
    readonly sandboxModule: VercelModule;
  },
  open: (
    sandboxName: string,
    options: { readonly mayCreate: boolean },
  ) => Promise<(Session & { readonly sandbox: VercelSandbox }) | null>,
  ready: (sandbox: VercelSandbox) => Promise<void>,
): Promise<{ readonly sandboxName: string; readonly session: Session }> {
  const listed = await latestToolSessionGeneration(input);
  let generation = listed ?? 0;
  for (let attempt = 1; ; attempt += 1) {
    const sandboxName = toolSessionSandboxName(input.baseName, generation);
    const session = await open(sandboxName, {
      mayCreate: listed === undefined || generation > listed,
    });
    // Only the listed generation can be missing: it was retired.
    if (session !== null) {
      try {
        await ready(session.sandbox);
        return { sandboxName, session };
      } catch (error) {
        const expired = !session.created && isVercelSnapshotNotFoundError(error);
        if (!expired || attempt >= MAX_TOOL_SESSION_GENERATIONS) throw error;
      }
    }
    generation += 1;
  }
}

function toolSessionSandboxName(baseName: string, generation: number): string {
  return generation === 0 ? baseName : `${baseName}-${generation}`;
}

function toolSessionGeneration(baseName: string, sandboxName: string): number | undefined {
  if (sandboxName === baseName) return 0;
  if (!sandboxName.startsWith(`${baseName}-`)) return undefined;
  const suffix = sandboxName.slice(baseName.length + 1);
  return /^[1-9]\d*$/u.test(suffix) ? Number(suffix) : undefined;
}

/*
 * The newest generation the provider lists, or `undefined` when it lists
 * none. A listing that lags behind a create only points at an older, expired
 * generation; opening it fails with the expiry and moves on to the name the
 * newer sandbox already holds.
 */
async function latestToolSessionGeneration(input: {
  readonly baseName: string;
  readonly createOptions: VercelCreateOptions;
  readonly sandboxModule: VercelModule;
}): Promise<number | undefined> {
  let credentials = {};
  try {
    credentials = await getVercelSandboxCredentials(input.createOptions);
  } catch {
    // Fall back to the SDK's own credential resolution, as lookups do.
  }
  const listed = await input.sandboxModule.Sandbox.list({
    ...credentials,
    fetch: getVercelSandboxFetch(input.createOptions),
    namePrefix: input.baseName,
    signal: input.createOptions.signal,
    sortBy: "name",
  });
  let latest: number | undefined;
  for await (const sandbox of listed) {
    const generation = toolSessionGeneration(input.baseName, sandbox.name);
    if (generation !== undefined && (latest === undefined || generation > latest)) {
      latest = generation;
    }
  }
  return latest;
}
