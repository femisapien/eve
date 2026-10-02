import { jsonSchema, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { contextStorage } from "#context/container.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type {
  HarnessSession,
  StepInput,
  StepResult,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import {
  createApprovalContext,
  textStreamResult,
  toolCallStreamResult,
} from "#internal/testing/approval-resume.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";
import { always, once } from "#tools/approval/policies.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;

function deployCall(callId = "call-1") {
  return { input: JSON.stringify({ service: "api" }), toolCallId: callId, toolName: "deploy" };
}

/**
 * Alice's release agent with one `deploy` tool. The model answers from a
 * script; every step runs in the same context, as one session's steps do.
 */
function setup(input: {
  readonly tool: Partial<HarnessToolDefinition>;
  readonly responses: readonly StreamResult[];
}) {
  const events: UnstampedMessageStreamEvent[] = [];
  const responses = [...input.responses];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error("Unexpected model call.");
      return next;
    },
    modelId: "approval-model",
    provider: "eve-integration-mock",
  });
  const execute = vi.fn(async (args: unknown) => ({
    deployed: (args as { service: string }).service,
  }));
  const deploy: HarnessToolDefinition = {
    description: "Deploy a service.",
    execute,
    inputSchema: jsonSchema({ type: "object" }),
    name: "deploy",
    ...input.tool,
  };
  const config: ToolLoopHarnessConfig = {
    handleEvent: async (event) => {
      events.push(event);
    },
    resolveModel: async () => model,
    tools: new Map([["deploy", deploy]]),
  };
  const ctx = createApprovalContext();
  const runStep = createToolLoopHarness(config);
  /** Runs a step and every step it schedules, as the session does within a turn. */
  const step = async (session: HarnessSession, stepInput?: StepInput): Promise<StepResult> => {
    let result = await contextStorage.run(ctx, () => runStep(session, stepInput));
    while (typeof result.next === "function") {
      const { next, session: current } = result;
      result = await contextStorage.run(ctx, () => next(current));
    }
    return result;
  };
  const session: HarnessSession = {
    agent: { modelReference: { id: "approval-model" }, system: "Help Alice release.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:approval-session",
    history: [],
    sessionId: "generate-approval-resume-session",
  };
  return { events, execute, model, responses, session, step };
}

function requested(events: readonly UnstampedMessageStreamEvent[]): InputRequest[] {
  return events.flatMap((event) => (event.type === "input.requested" ? event.data.requests : []));
}

function partTypes(history: readonly ModelMessage[]): string[] {
  return history.flatMap((message) =>
    typeof message.content === "string"
      ? [`${message.role}:text`]
      : message.content.map((part) => `${message.role}:${part.type}`),
  );
}

describe("tool approvals in the tool loop (real AI SDK)", () => {
  it("holds the turn without calling the model, then runs the approved call in eve", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall()), textStreamResult("Deployed api.")],
      tool: { approval: always() },
    });

    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });

    expect(held.held).toEqual({ kind: "input" });
    expect(fixture.model.doStreamCalls).toHaveLength(1);
    expect(fixture.events.at(-1)).toMatchObject({ data: { on: "input" }, type: "turn.waiting" });
    // The waiting call stays in history without a result, and no approval part enters it.
    expect(partTypes(held.session.history)).toEqual(["user:text", "assistant:tool-call"]);

    const [request] = requested(fixture.events);
    const start = fixture.events.length;
    const resumed = await fixture.step(held.session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
    });

    expect(fixture.execute).toHaveBeenCalledExactlyOnceWith(
      { service: "api" },
      expect.objectContaining({ toolCallId: "call-1" }),
    );
    expect(fixture.model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(fixture.model.doStreamCalls[1]!.prompt)).toContain("deployed");
    const types = fixture.events.slice(start).map((event) => event.type);
    expect(types).not.toContain("turn.started");
    expect(types.indexOf("input.resolved")).toBeLessThan(types.indexOf("action.result"));
    expect(partTypes(resumed.session.history)).toEqual([
      "user:text",
      "assistant:tool-call",
      "tool:tool-result",
      "assistant:text",
    ]);
  });

  it("never runs a denied call, and the model reads the denial", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall()), textStreamResult("Alice declined.")],
      tool: { approval: always() },
    });
    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });
    const [request] = requested(fixture.events);

    await fixture.step(held.session, {
      inputResponses: [{ optionId: "cancel", requestId: request!.requestId }],
    });

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.model.doStreamCalls[1]!.prompt)).toContain(
      "Tool execution was denied.",
    );
    expect(fixture.events).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ status: "rejected" }) }),
    );
  });

  it("lets a once() approval run the tool's next call without asking again", async () => {
    const fixture = setup({
      responses: [
        toolCallStreamResult(deployCall("call-1")),
        textStreamResult("Deployed."),
        toolCallStreamResult(deployCall("call-2")),
        textStreamResult("Deployed again."),
      ],
      tool: { approval: once() },
    });
    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });
    const [request] = requested(fixture.events);
    const approved = await fixture.step(held.session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
    });

    const again = await fixture.step(approved.session, { message: "Deploy it once more." });

    expect(requested(fixture.events)).toHaveLength(1);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(again.held).toBeUndefined();
  });

  it("re-checks the approval before running, and doesn't run a call the policy now refuses", async () => {
    let checks = 0;
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall()), textStreamResult("The deploy was refused.")],
      tool: { approval: () => (++checks === 1 ? "user-approval" : "denied") },
    });
    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });
    const [request] = requested(fixture.events);

    await fixture.step(held.session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
    });

    expect(checks).toBe(2);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.events.filter((event) => event.type === "action.result")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({
            output: expect.objectContaining({ tool: { result: "not_run" } }),
          }),
          status: "rejected",
        }),
      }),
    ]);
  });

  it("steers past the approval when Alice sends a message, then reads it after the not-run result", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall()), textStreamResult("The draft is ready.")],
      tool: { approval: always() },
    });
    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });

    const steered = await fixture.step(held.session, { message: "Skip that; is the draft ready?" });

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.events).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          resolutions: [expect.objectContaining({ outcome: "ignored" })],
        }),
        type: "input.resolved",
      }),
    );
    expect(partTypes(steered.session.history)).toEqual([
      "user:text",
      "assistant:tool-call",
      "tool:tool-result",
      // eve's boundary between tool results and the user's next message.
      "assistant:text",
      "user:text",
      "assistant:text",
    ]);
  });

  it("fails the turn when the approved tool is gone", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall())],
      tool: { approval: always() },
    });
    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });
    const [request] = requested(fixture.events);
    const withoutDeploy = createToolLoopHarness({
      handleEvent: async () => {},
      resolveModel: async () => fixture.model,
      tools: new Map(),
    });

    await expect(
      contextStorage.run(createApprovalContext(), () =>
        withoutDeploy(held.session, {
          inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
        }),
      ),
    ).rejects.toThrow("The approved tool is no longer available.");
  });

  it("dispatches an approved workflow tool as runtime work, and reads Alice's message after its result", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall()), textStreamResult("Deployed; telling Alice.")],
      tool: {
        approval: always(),
        execute: undefined,
        workflowId: "workflow//./agent/tools/deploy//execute",
      },
    });
    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });
    const [request] = requested(fixture.events);

    const dispatched = await fixture.step(held.session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
      message: "Tell Alice when it finishes.",
    });

    expect(dispatched.next).toBeNull();
    expect(
      getPendingCoordinationBatch(dispatched.session.state)?.tasks.map((task) => task.callId),
    ).toEqual(["call-1"]);
    expect(fixture.model.doStreamCalls).toHaveLength(1);

    const completed = await fixture.step(dispatched.session, {
      runtimeActionResults: [
        { callId: "call-1", kind: "tool-result", output: "deployed", toolName: "deploy" },
      ],
    });

    expect(partTypes(completed.session.history)).toEqual([
      "user:text",
      "assistant:tool-call",
      "tool:tool-result",
      // eve's boundary between tool results and the user's next message.
      "assistant:text",
      "user:text",
      "assistant:text",
    ]);
    expect(JSON.stringify(completed.session.history)).toContain("Tell Alice when it finishes.");
  });
});
