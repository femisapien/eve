import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { BashJobsKey } from "./bash-jobs.js";

import { EVE_DEV_ENV_FLAG } from "#internal/application/optional-package-install.js";
import type { SandboxCommandResult, SandboxSession } from "#shared/sandbox-session.js";

import { executeBashOnSandbox } from "./bash.js";
import { bufferToStream } from "./stream-utils.js";

describe("executeBashOnSandbox", () => {
  const previousDevFlag = process.env[EVE_DEV_ENV_FLAG];

  afterEach(() => {
    if (previousDevFlag === undefined) {
      delete process.env[EVE_DEV_ENV_FLAG];
    } else {
      process.env[EVE_DEV_ENV_FLAG] = previousDevFlag;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("warns when a yielded command cannot be tracked without registering an unsafe identity", async () => {
    const { records } = captureLogRecords();
    vi.useFakeTimers();
    const context = new ContextContainer();
    context.setVirtualContext(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "session-untracked",
      turn: { id: "turn-untracked", sequence: 0 },
    });
    const sandbox: SandboxSession = {
      ...createTestSandboxSession({ exitCode: 0, stderr: "", stdout: "" }),
      spawn: async () => ({
        kill: async () => {},
        stderr: new ReadableStream(),
        stdout: new ReadableStream(),
        wait: () => new Promise(() => {}),
      }),
      run: async ({ command }) => {
        const marker = /eve-bash:[0-9a-f]+/.exec(command)?.[0];
        if (marker === undefined) throw new Error("Expected a job claim.");
        return { exitCode: 0, stderr: "", stdout: `${marker} 123 0 0 \n` };
      },
    };
    const call = contextStorage.run(context, () =>
      executeBashOnSandbox(sandbox, { command: "long-command" }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await call).toMatchObject({ status: "running", pid: 123 });
    expect(context.get(BashJobsKey)).toBeUndefined();
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({
          sessionId: "session-untracked",
          turnId: "turn-untracked",
          pid: 123,
        }),
      }),
    );
  });

  it("logs sandbox command progress in dev without adding to stderr", async () => {
    process.env[EVE_DEV_ENV_FLAG] = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const sandbox = createTestSandboxSession({
      exitCode: 0,
      stderr: "",
      stdout: "weather-codes.md\n",
    });

    const result = await executeBashOnSandbox(sandbox, { command: "ls -la /workspace" });

    expect(result).toEqual({
      exitCode: 0,
      status: "completed",
      stderr: "",
      stdout: "weather-codes.md\n",
      truncated: false,
    });
    expect(log).toHaveBeenCalledWith("eve: starting sandbox command: ls -la /workspace");
    expect(log).toHaveBeenCalledWith("eve: sandbox command finished (exit 0): ls -la /workspace");
  });
});

function createTestSandboxSession(result: SandboxCommandResult): SandboxSession {
  const encoder = new TextEncoder();
  return {
    readBinaryFile: async () => null,
    readFile: async () => null,
    readTextFile: async () => null,
    removePath: async () => {},
    resolvePath: (path) => path,
    run: async () => {
      throw new Error("run is not used by a command that finishes in time");
    },
    spawn: async () => ({
      kill: async () => {},
      stderr: bufferToStream(encoder.encode(result.stderr)),
      stdout: bufferToStream(encoder.encode(result.stdout)),
      wait: async () => ({ exitCode: result.exitCode }),
    }),
    writeBinaryFile: async () => {},
    writeFile: async () => {},
    writeTextFile: async () => {},
  };
}
