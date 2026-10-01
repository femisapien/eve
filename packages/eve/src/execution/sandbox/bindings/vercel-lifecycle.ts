import {
  getVercelSandboxCredentials,
  getVercelSandboxFetch,
  type VercelSandboxCredentials,
} from "#execution/sandbox/bindings/vercel-credentials.js";
import type {
  VercelCreateOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";

/**
 * Stops and deletes a sandbox. With `keep`, the delete is conditional: nothing
 * is stopped, and `keep` is asked about the sandbox fetched by the final lookup,
 * immediately before the delete request, after every other await. Returns
 * whether the sandbox was deleted.
 */
export async function deleteVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly keep?: (sandbox: VercelSandbox) => boolean;
  readonly loadDeleteSandboxModule: () => Promise<VercelModule>;
  readonly sandbox: VercelSandbox;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  if (input.keep === undefined) await stopVercelSandbox(input.sandbox);
  return await deleteVercelSandboxRecord(input);
}

export async function deleteUnusableVercelSandbox(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadDeleteSandboxModule: () => Promise<VercelModule>;
  readonly sandbox: VercelSandbox;
}): Promise<void> {
  await deleteVercelSandboxRecord(input);
}

async function deleteVercelSandboxRecord(input: {
  readonly createOptions: VercelCreateOptions;
  readonly keep?: (sandbox: VercelSandbox) => boolean;
  readonly loadDeleteSandboxModule: () => Promise<VercelModule>;
  readonly sandbox: VercelSandbox;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const credentials = await resolveVercelSandboxCredentials(input.createOptions);
  const sandboxModule = await input.loadDeleteSandboxModule();
  const sandbox = await sandboxModule.Sandbox.get({
    ...credentials,
    fetch: getVercelSandboxFetch(input.createOptions),
    name: input.sandbox.name,
    resume: false,
    signal: input.signal,
  });
  // The final boundary: nothing is awaited between this check and the request.
  if (input.keep?.(sandbox) === true) return false;
  await sandbox.delete({
    deleteOrphanSnapshots: true,
    signal: input.signal,
  });
  return true;
}

export async function stopVercelSandbox(sandbox: VercelSandbox): Promise<void> {
  if (sandbox.status !== "running" && sandbox.status !== "pending") {
    return;
  }
  await sandbox.stop();
}

async function resolveVercelSandboxCredentials(
  createOptions: VercelCreateOptions,
): Promise<VercelSandboxCredentials | Record<string, never>> {
  try {
    return await getVercelSandboxCredentials(createOptions);
  } catch {
    return {};
  }
}
