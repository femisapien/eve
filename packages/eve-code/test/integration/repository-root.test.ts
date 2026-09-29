import assert from "node:assert/strict";
import test from "node:test";

import type { SandboxSession } from "eve/sandbox";

import {
  resolveWorkspaceRoot,
  validateRepositoryRoot,
} from "../../extension/lib/repository-root.ts";

test("patch roots default to the workspace and need no git checkout", async () => {
  const runs: string[] = [];
  const sandbox = workspaceSandbox("/app", runs);
  assert.equal(await resolveWorkspaceRoot(sandbox), "/app");
  assert.equal(await resolveWorkspaceRoot(sandbox, "/app/src"), "/app/src");
  assert.equal(
    runs.some((command) => command.startsWith("git ")),
    false,
  );
});

test("patch roots must stay inside the workspace", async () => {
  await assert.rejects(
    resolveWorkspaceRoot(workspaceSandbox("/app"), "/etc"),
    /root must be inside the sandbox workspace \/app: \/etc/u,
  );
  await assert.rejects(resolveWorkspaceRoot(workspaceSandbox("/app"), "src"), /absolute/u);
});

function workspaceSandbox(
  workspace: string,
  runs: string[] = [],
): Pick<SandboxSession, "resolvePath" | "run"> {
  return {
    resolvePath: () => workspace,
    async run({ command }) {
      runs.push(command);
      const [, path = ""] = /realpath -e -- '([^']*)'/u.exec(command) ?? [];
      return { exitCode: 0, stdout: `${path}\n`, stderr: "" };
    },
  };
}

test("accepts a git root inside the sandbox workspace", async () => {
  const sandbox = rootSandbox("/workspace/repo");
  assert.equal(await validateRepositoryRoot(sandbox, "/workspace/repo"), "/workspace/repo");
});

test("rejects roots outside the workspace and nested git paths", async () => {
  await assert.rejects(
    validateRepositoryRoot(rootSandbox("/outside/repo"), "/outside/repo"),
    /inside the sandbox workspace/u,
  );
  await assert.rejects(
    validateRepositoryRoot(rootSandbox("/workspace/repo", "/workspace"), "/workspace/repo"),
    /not a git work tree root/u,
  );
});

function rootSandbox(
  resolvedRoot: string,
  gitTop = resolvedRoot,
): Pick<SandboxSession, "resolvePath" | "run"> {
  return {
    resolvePath() {
      return "/workspace";
    },
    async run({ command }) {
      if (command.includes("realpath") && command.includes(`'${resolvedRoot}'`)) {
        return { exitCode: 0, stdout: `${resolvedRoot}\n`, stderr: "" };
      }
      if (command.includes("realpath")) {
        return { exitCode: 0, stdout: "/workspace\n", stderr: "" };
      }
      return { exitCode: 0, stdout: `${gitTop}\n`, stderr: "" };
    },
  };
}
