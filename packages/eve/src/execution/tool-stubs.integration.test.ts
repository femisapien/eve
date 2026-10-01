import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadContext } from "#context/container.js";
import { ToolStubSetKey } from "#context/keys.js";
import { selectToolStubSet } from "#execution/tool-stubs.js";
import { isTurnFailingToolError } from "#harness/tool-turn-failure.js";
import {
  EVE_EVALUATION_ENV_FLAG,
  EVE_EVALUATION_TOOL_STUBS_DIR_ENV,
} from "#internal/application/dev-environment.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { mockTool } from "#internal/testing/mocks/mock-tool.js";
import { markProvidedTool } from "#tools/provided/provided-tool.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";

// Stub files carry the `defineToolStubs()` brand directly, so they load from a
// temporary app root that cannot resolve `eve/evals`.
const LEDGER_SET = `
export default {
  _tag: "EveToolStubs",
  state: () => ({ entries: ["seeded"] }),
  tools: {
    record_entry: (input, ctx) => {
      ctx.state.entries.push(input.entry);
      return { entries: [...ctx.state.entries], toolName: ctx.toolName };
    },
    list_entries: (_input, ctx) => ({ entries: [...ctx.state.entries] }),
  },
};
`;

const createAppRoot = useTemporaryAppRoots();

afterEach(() => {
  vi.unstubAllEnvs();
});

async function useEvalStubs(files: Readonly<Record<string, string>>): Promise<void> {
  const { appRoot } = await createAppRoot("eve-tool-stubs-", { files });
  vi.stubEnv(EVE_EVALUATION_ENV_FLAG, "1");
  vi.stubEnv(EVE_EVALUATION_TOOL_STUBS_DIR_ENV, join(appRoot, "evals", "stubs"));
}

describe("selectToolStubSet", () => {
  it("rejects stubs on a server that eve eval did not start", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    vi.stubEnv(EVE_EVALUATION_ENV_FLAG, "");

    const selection = await selectToolStubSet("ledger");

    expect(selection).toEqual({
      ok: false,
      error: expect.stringContaining("accepted only by the local server that `eve eval` starts"),
    });
  });

  it("lists the sets it found when the name is unknown", async () => {
    await useEvalStubs({
      "evals/stubs/ledger.ts": LEDGER_SET,
      "evals/stubs/nested/empty.ts": `export default { _tag: "EveToolStubs", tools: {} };`,
    });

    const selection = await selectToolStubSet("ledgr");

    expect(selection).toEqual({
      ok: false,
      error: 'Unknown tool stub set "ledgr". Sets in evals/stubs/: ledger, nested/empty.',
    });
  });

  it("rejects a set whose default export is not a stub set", async () => {
    await useEvalStubs({ "evals/stubs/broken.ts": "export default { tools: {} };" });

    const selection = await selectToolStubSet("broken");

    expect(selection).toEqual({
      ok: false,
      error: expect.stringContaining("must default-export defineToolStubs"),
    });
  });

  it("accepts a set that loads", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });

    expect(await selectToolStubSet("ledger")).toEqual({ ok: true, set: "ledger" });
  });
});

describe("stubbed tool execution", () => {
  const realRecord = vi.fn(() => ({ real: true }));
  const realList = vi.fn(() => ({ real: true }));
  const realUnstubbed = vi.fn(() => ({ real: true }));

  async function createRuntime() {
    realRecord.mockClear();
    realList.mockClear();
    realUnstubbed.mockClear();
    return await createTestRuntime({
      tools: [
        mockTool({ name: "record_entry", execute: realRecord }),
        mockTool({ name: "list_entries", execute: realList }),
        mockTool({ name: "unstubbed_tool", execute: realUnstubbed }),
      ],
    });
  }

  it("runs the real tool in a session without a stub set", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    const runtime = await createRuntime();

    const output = await runtime.runAsSession({ sessionId: "session_unstubbed" }, () =>
      runtime.executeTool("record_entry", { entry: "a" }),
    );

    expect(output).toEqual({ real: true });
    expect(realRecord).toHaveBeenCalledTimes(1);
  });

  it("runs the stub in place of the real tool and keeps state across calls", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    const runtime = await createRuntime();

    const outputs = await runtime.runAsSession({ sessionId: "session_ledger_calls" }, async () => {
      loadContext().set(ToolStubSetKey, "ledger");
      return [
        await runtime.executeTool("record_entry", { entry: "first" }),
        await runtime.executeTool("list_entries", {}),
      ];
    });

    expect(outputs).toEqual([
      { entries: ["seeded", "first"], toolName: "record_entry" },
      { entries: ["seeded", "first"] },
    ]);
    expect(realRecord).not.toHaveBeenCalled();
    expect(realList).not.toHaveBeenCalled();
  });

  it("fails the turn without running the real tool when the set has no stub", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    const runtime = await createRuntime();

    const failure = await runtime
      .runAsSession({ sessionId: "session_missing_stub" }, () => {
        loadContext().set(ToolStubSetKey, "ledger");
        return runtime.executeTool("unstubbed_tool", {});
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(isTurnFailingToolError(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: "TOOL_STUB_MISSING",
      message: expect.stringContaining('Tool stub set "ledger" has no stub for "unstubbed_tool"'),
    });
    expect(realUnstubbed).not.toHaveBeenCalled();
  });

  it("runs framework tools as usual in a stubbed session", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    const runtime = await createRuntime();

    const outcome = await runtime
      .runAsSession({ sessionId: "session_framework_tool" }, () => {
        loadContext().set(ToolStubSetKey, "ledger");
        return runtime.executeTool("load_skill", { name: "no-such-skill" });
      })
      .then(
        (output: unknown) => ({ output }),
        (error: unknown) => ({ error }),
      );

    expect("error" in outcome && isTurnFailingToolError(outcome.error)).toBe(false);
  });

  it("runs eve-provided tools that the app mounts as usual in a stubbed session", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    const realProvided = vi.fn(() => ({ real: true }));
    const runtime = await createTestRuntime({
      tools: [markProvidedTool(mockTool({ name: "no_reply", execute: realProvided }))],
    });

    const output = await runtime.runAsSession({ sessionId: "session_provided_tool" }, () => {
      loadContext().set(ToolStubSetKey, "ledger");
      return runtime.executeTool("no_reply", {});
    });

    expect(output).toEqual({ real: true });
    expect(realProvided).toHaveBeenCalledTimes(1);
  });

  it("shares one state between a root session and its subagents", async () => {
    await useEvalStubs({ "evals/stubs/ledger.ts": LEDGER_SET });
    const runtime = await createRuntime();

    await runtime.runAsSession({ sessionId: "session_root_shared" }, async () => {
      loadContext().set(ToolStubSetKey, "ledger");
      await runtime.executeTool("record_entry", { entry: "from-root" });
    });
    const childOutput = await runtime.runAsSession(
      {
        parent: {
          callId: "call_parent",
          rootSessionId: "session_root_shared",
          sessionId: "session_root_shared",
          turn: { id: "turn_parent", sequence: 1 },
        },
        sessionId: "session_child_shared",
      },
      async () => {
        loadContext().set(ToolStubSetKey, "ledger");
        await runtime.executeTool("record_entry", { entry: "from-child" });
        return await runtime.executeTool("list_entries", {});
      },
    );
    const rootOutput = await runtime.runAsSession({ sessionId: "session_root_shared" }, () => {
      loadContext().set(ToolStubSetKey, "ledger");
      return runtime.executeTool("list_entries", {});
    });

    expect(childOutput).toEqual({ entries: ["seeded", "from-root", "from-child"] });
    expect(rootOutput).toEqual({ entries: ["seeded", "from-root", "from-child"] });
  });
});
