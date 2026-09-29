import type { SandboxSession } from "eve/sandbox";

import { shellQuote } from "./shell.ts";

type RootSandbox = Pick<SandboxSession, "resolvePath" | "run">;

/**
 * Resolves `root` (default: the workspace root) to a real directory inside the
 * sandbox workspace. Git is not required; callers that need a repository use
 * {@link validateRepositoryRoot}.
 */
export async function resolveWorkspaceRoot(sandbox: RootSandbox, root?: string): Promise<string> {
  if (root !== undefined && !root.startsWith("/")) {
    throw new Error("root must be an absolute sandbox path");
  }
  const workspace = await realPath(sandbox, sandbox.resolvePath(""), "sandbox workspace");
  if (root === undefined) return workspace;
  const resolved = await realPath(sandbox, root, "root");
  if (resolved !== workspace && !resolved.startsWith(`${workspace}/`)) {
    throw new Error(`root must be inside the sandbox workspace ${workspace}: ${root}`);
  }
  return resolved;
}

export async function validateRepositoryRoot(sandbox: RootSandbox, root: string): Promise<string> {
  const resolved = await resolveWorkspaceRoot(sandbox, root);
  const top = await sandbox.run({
    command: `git -C ${shellQuote(resolved)} rev-parse --show-toplevel`,
  });
  if (top.exitCode !== 0 || top.stdout.trim() !== resolved) {
    throw new Error(`root is not a git work tree root: ${root}`);
  }
  return resolved;
}

async function realPath(sandbox: RootSandbox, path: string, label: string): Promise<string> {
  const result = await sandbox.run({ command: `realpath -e -- ${shellQuote(path)}` });
  if (result.exitCode !== 0)
    throw new Error(`Could not resolve ${label} ${path}: ${result.stderr}`);
  return result.stdout.trim();
}
