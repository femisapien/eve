import { join } from "node:path";

import { jsonSchema } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolStubsSelection } from "#channel/types.js";
import { contextStorage, loadContext } from "#context/container.js";
import { ToolStubsKey } from "#context/keys.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { selectToolStubs, withToolStubs } from "#evals/tool-stubs.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession } from "#harness/types.js";
import {
  EVE_EVALUATION_ENV_FLAG,
  EVE_EVALUATION_TOOL_STUBS_DIR_ENV,
} from "#internal/application/dev-environment.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  createApprovalContext,
  textStreamResult,
  toolCallStreamResult,
} from "#internal/testing/approval-resume.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { always } from "#tools/approval/policies.js";

// The harness runs outside a workflow body here, where run attributes cannot be written.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

const TWO_WORKFLOWS = `
import { defineToolStubs } from "eve/evals";

export default defineToolStubs({
  state: () => ({ schedules: [{ id: "sched_1", name: "Weekly commit activity" }] }),
  tools: {
    schedules_read: (input, { state }) => ({ schedules: state.schedules }),
    schedules_create: (input, { state, toolName }) => {
      const schedule = { id: "sched_2", ...input };
      state.schedules.push(schedule);
      return { schedule, toolName };
    },
  },
});
`;

const createAppRoot = useTemporaryAppRoots();
let realCalls: string[] = [];

function tool(name: string, owner: ResolvedToolDefinition["owner"]): ResolvedToolDefinition {
  const logicalPath = `tools/${name}.ts`;
  return {
    description: `${name} test tool.`,
    execute: () => {
      realCalls.push(name);
      return { real: name };
    },
    inputSchema: null,
    logicalPath,
    name,
    owner,
    sourceId: logicalPath,
    sourceKind: "module",
  };
}

const schedulesRead = tool("schedules_read", { kind: "application" });
const schedulesCreate = tool("schedules_create", { kind: "application" });
const schedulesDelete = tool("schedules_delete", { kind: "application" });

async function useStubsDirectory(files: Readonly<Record<string, string>>): Promise<void> {
  const { appRoot } = await createAppRoot("eve-tool-stubs-", { files });
  process.env[EVE_EVALUATION_ENV_FLAG] = "1";
  process.env[EVE_EVALUATION_TOOL_STUBS_DIR_ENV] = join(appRoot, "evals", "stubs");
}

beforeEach(() => {
  realCalls = [];
});

afterEach(() => {
  delete process.env[EVE_EVALUATION_ENV_FLAG];
  delete process.env[EVE_EVALUATION_TOOL_STUBS_DIR_ENV];
});

describe("tool stubs in a stubbed session", () => {
  it("run in place of execute and share the state they write", async () => {
    await useStubsDirectory({ "evals/stubs/two-workflows.ts": TWO_WORKFLOWS });
    const selection = await selectToolStubs("two-workflows");
    const runtime = await createTestRuntime({ tools: [schedulesRead, schedulesCreate] });

    const results = await runtime.runAsSession(undefined, async () => {
      loadContext().set(ToolStubsKey, selection);
      const created = await runtime.executeTool(schedulesCreate, { name: "Canary check" });
      const read = await runtime.executeTool(schedulesRead, {});
      return { created, read };
    });

    expect(results).toEqual({
      created: { schedule: { id: "sched_2", name: "Canary check" }, toolName: "schedules_create" },
      read: {
        schedules: [
          { id: "sched_1", name: "Weekly commit activity" },
          { id: "sched_2", name: "Canary check" },
        ],
      },
    });
    expect(realCalls).toEqual([]);
  });

  it("share one state between sessions that carry the same world", async () => {
    await useStubsDirectory({ "evals/stubs/two-workflows.ts": TWO_WORKFLOWS });
    const parent = await selectToolStubs("two-workflows");
    const runtime = await createTestRuntime({ tools: [schedulesRead, schedulesCreate] });

    await runtime.runAsSession({ sessionId: "session_parent" }, async () => {
      loadContext().set(ToolStubsKey, parent);
      await runtime.executeTool(schedulesCreate, { name: "Canary check" });
    });
    const childRead = await runtime.runAsSession({ sessionId: "session_child" }, async () => {
      loadContext().set(ToolStubsKey, parent);
      return await runtime.executeTool(schedulesRead, {});
    });
    const otherRoot = await selectToolStubs("two-workflows");
    const otherRead = await runtime.runAsSession({ sessionId: "session_other" }, async () => {
      loadContext().set(ToolStubsKey, otherRoot);
      return await runtime.executeTool(schedulesRead, {});
    });

    expect(childRead).toEqual({
      schedules: [
        { id: "sched_1", name: "Weekly commit activity" },
        { id: "sched_2", name: "Canary check" },
      ],
    });
    expect(otherRead).toEqual({ schedules: [{ id: "sched_1", name: "Weekly commit activity" }] });
  });

  it("fail the turn for an authored tool without a stub, and never run it", async () => {
    await useStubsDirectory({ "evals/stubs/two-workflows.ts": TWO_WORKFLOWS });
    const selection = await selectToolStubs("two-workflows");
    const runtime = await createTestRuntime({ tools: [schedulesDelete] });

    const failure = runtime.runAsSession(undefined, async () => {
      loadContext().set(ToolStubsKey, selection);
      return await runtime.executeTool(schedulesDelete, { id: "sched_1" });
    });

    await expect(failure).rejects.toMatchObject({
      code: "TOOL_STUB_MISSING",
      message:
        'Stub set "two-workflows" has no stub for tool "schedules_delete", so the real tool did not run. ' +
        "Add tools.schedules_delete to evals/stubs/two-workflows.ts.",
      name: "TurnFailingToolError",
    });
    expect(realCalls).toEqual([]);
  });

  it("run eve's built-in tools for real when the set has no stub for them", async () => {
    await useStubsDirectory({ "evals/stubs/two-workflows.ts": TWO_WORKFLOWS });
    const selection = await selectToolStubs("two-workflows");
    const runtime = await createTestRuntime();
    const sandbox = mockSandbox({
      commands: { pwd: { exitCode: 0, stderr: "", stdout: "/workspace\n" } },
    });

    await runtime.runAsSession({ sandbox }, async () => {
      loadContext().set(ToolStubsKey, selection);
      return await runtime.executeTool("bash", { command: "pwd" });
    });

    expect(sandbox.commandLog).toEqual(["pwd"]);
  });
});

describe("selectToolStubs", () => {
  it("names a set by its path under evals/stubs and starts a new world for it", async () => {
    await useStubsDirectory({ "evals/stubs/slack/two-channels.ts": TWO_WORKFLOWS });

    const first = await selectToolStubs("slack/two-channels");
    const second = await selectToolStubs("slack/two-channels");

    expect(first).toEqual({ set: "slack/two-channels", worldId: expect.any(String) });
    expect(second.worldId).not.toBe(first.worldId);
  });

  it("lists the sets it found when the name is unknown", async () => {
    await useStubsDirectory({
      "evals/stubs/two-workflows.ts": TWO_WORKFLOWS,
      "evals/stubs/slack/two-channels.ts": TWO_WORKFLOWS,
    });

    await expect(selectToolStubs("three-workflows")).rejects.toThrow(
      'Unknown stub set "three-workflows". Stub sets in evals/stubs/: slack/two-channels, two-workflows.',
    );
  });

  it("rejects a file that does not default-export defineToolStubs", async () => {
    await useStubsDirectory({ "evals/stubs/broken.ts": "export default { tools: {} };\n" });

    await expect(selectToolStubs("broken")).rejects.toThrow(
      'evals/stubs/broken.ts must default-export defineToolStubs({ ... }) from "eve/evals".',
    );
  });

  it("rejects every set outside the server eve eval starts", async () => {
    const selection = selectToolStubs("two-workflows");

    await expect(selection).rejects.toThrow(
      "'stubs' is accepted only by the agent server that `eve eval` starts. " +
        "Stub sets are not available to `eve eval --url` targets or deployed agents.",
    );
  });
});

describe("tool stubs in the tool loop", () => {
  function loopTool(name: string, approval?: HarnessToolDefinition["approval"]) {
    return {
      approval,
      description: `${name} test tool.`,
      execute: createToolExecuteWithAuth({
        execute: withToolStubs(() => {
          realCalls.push(name);
          return { real: name };
        }, "fail"),
        scope: name,
      }),
      inputSchema: jsonSchema({ type: "object" }),
      name,
    } satisfies HarnessToolDefinition;
  }

  function setup(tool: HarnessToolDefinition, selection: ToolStubsSelection) {
    const events: UnstampedMessageStreamEvent[] = [];
    const model = new MockLanguageModelV4({
      doStream: vi
        .fn()
        .mockImplementationOnce(async () =>
          toolCallStreamResult({
            input: JSON.stringify({ name: "Canary check" }),
            toolCallId: "call-1",
            toolName: tool.name,
          }),
        )
        .mockImplementation(async () => textStreamResult("Done.")),
      modelId: "tool-stubs-model",
      provider: "eve-integration-mock",
    });
    const runStep = createToolLoopHarness({
      capabilities: { requestInput: true },
      handleEvent: async (event) => {
        events.push(event);
      },
      resolveModel: async () => model,
      tools: new Map([[tool.name, tool]]),
    });
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "tool-stubs-model" },
        system: "Help Alice keep track of her workflows.",
        tools: [],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "http:tool-stubs-session",
      history: [],
      sessionId: "tool-stubs-session",
    };
    const step = (current: HarnessSession, input: Parameters<typeof runStep>[1]) => {
      const ctx = createApprovalContext();
      ctx.set(ToolStubsKey, selection);
      return contextStorage.run(ctx, () => runStep(current, input));
    };
    const readSchedules = () => {
      const ctx = createApprovalContext();
      ctx.set(ToolStubsKey, selection);
      // A copy, because the stub returns the live state array.
      return contextStorage.run(ctx, async () =>
        structuredClone(
          await loopTool("schedules_read").execute({}, { messages: [], toolCallId: "call-read" }),
        ),
      );
    };
    return { events, model, readSchedules, session, step };
  }

  function pendingRequest(session: HarnessSession) {
    const [request] = getPendingInputBatches(session.state).flatMap((batch) => batch.requests);
    if (request === undefined) throw new Error("Expected a pending approval request.");
    return request;
  }

  it("fails the turn when the model calls a tool the set does not stub", async () => {
    await useStubsDirectory({ "evals/stubs/two-workflows.ts": TWO_WORKFLOWS });
    const fixture = setup(loopTool("schedules_delete"), await selectToolStubs("two-workflows"));
    const message =
      'Stub set "two-workflows" has no stub for tool "schedules_delete", so the real tool did not run. ' +
      "Add tools.schedules_delete to evals/stubs/two-workflows.ts.";

    const result = await fixture.step(fixture.session, { message: "Delete Alice's workflow." });

    expect(result.settledTurn).toEqual({ isError: true, output: message });
    expect(fixture.events.slice(-3)).toMatchObject([
      { data: { code: "TOOL_STUB_MISSING", message }, type: "step.failed" },
      { data: { code: "TOOL_STUB_MISSING", message }, type: "turn.failed" },
      { type: "session.waiting" },
    ]);
    expect(fixture.model.doStreamCalls).toHaveLength(1);
    expect(realCalls).toEqual([]);
  });

  it("fails the turn before the next model call when an approved call has no stub", async () => {
    await useStubsDirectory({ "evals/stubs/two-workflows.ts": TWO_WORKFLOWS });
    const fixture = setup(
      loopTool("schedules_delete", always()),
      await selectToolStubs("two-workflows"),
    );

    const parked = await fixture.step(fixture.session, { message: "Delete Alice's workflow." });
    const result = await fixture.step(parked.session, {
      inputResponses: [
        { optionId: "approve", requestId: pendingRequest(parked.session).requestId },
      ],
    });

    expect(result.settledTurn).toMatchObject({ isError: true });
    expect(fixture.events.slice(-2)).toMatchObject([
      { data: { code: "TOOL_STUB_MISSING" }, type: "turn.failed" },
      { type: "session.waiting" },
    ]);
    expect(fixture.model.doStreamCalls).toHaveLength(1);
    expect(realCalls).toEqual([]);
  });

  it("runs an approval-gated stub once, after the approval", async () => {
    await useStubsDirectory({ "evals/stubs/two-workflows.ts": TWO_WORKFLOWS });
    const fixture = setup(
      loopTool("schedules_create", always()),
      await selectToolStubs("two-workflows"),
    );

    const parked = await fixture.step(fixture.session, { message: "Add Alice's canary check." });
    const beforeApproval = await fixture.readSchedules();
    await fixture.step(parked.session, {
      inputResponses: [
        { optionId: "approve", requestId: pendingRequest(parked.session).requestId },
      ],
    });
    const afterApproval = await fixture.readSchedules();

    expect(beforeApproval).toEqual({
      schedules: [{ id: "sched_1", name: "Weekly commit activity" }],
    });
    expect(afterApproval).toEqual({
      schedules: [
        { id: "sched_1", name: "Weekly commit activity" },
        { id: "sched_2", name: "Canary check" },
      ],
    });
    expect(realCalls).toEqual([]);
  });

  it("never runs the stub for a denied call", async () => {
    await useStubsDirectory({ "evals/stubs/two-workflows.ts": TWO_WORKFLOWS });
    const fixture = setup(
      loopTool("schedules_create", always()),
      await selectToolStubs("two-workflows"),
    );

    const parked = await fixture.step(fixture.session, { message: "Add Alice's canary check." });
    const request = pendingRequest(parked.session);
    const deny = request.options?.find((option) => option.id !== "approve");
    await fixture.step(parked.session, {
      inputResponses: [{ optionId: deny!.id, requestId: request.requestId }],
    });

    expect(await fixture.readSchedules()).toEqual({
      schedules: [{ id: "sched_1", name: "Weekly commit activity" }],
    });
  });
});
