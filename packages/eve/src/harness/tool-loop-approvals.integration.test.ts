import { jsonSchema, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { HumanInput } from "#harness/hitl/index.js";
import { describe, expect, it, vi } from "vitest";

import { contextStorage } from "#context/container.js";
import {
  getAuthorizationResults,
  PendingAuthorizationResultKey,
  requestAuthorization,
} from "#harness/authorization.js";
import { shouldCompact } from "#harness/compaction.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type {
  HarnessSession,
  StepFn,
  StepInput,
  StepResult,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import {
  createApprovalContext,
  textStreamResult,
  toolCallStreamResult,
  toolCallsStreamResult,
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
  /** Tools beside `deploy`. */
  readonly tools?: readonly HarnessToolDefinition[];
  /** Whether the session can ask a person, as the budget question needs. */
  readonly requestInput?: boolean;
}) {
  const events: UnstampedMessageStreamEvent[] = [];
  const responses = [...input.responses];
  const model = new MockLanguageModelV4({
    // A compaction the threshold triggers summarizes with the turn's model.
    doGenerate: {
      content: [{ text: "Alice asked to deploy the api service.", type: "text" }],
      finishReason: { raw: undefined, unified: "stop" },
      usage: {
        inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
        outputTokens: { reasoning: undefined, text: 1, total: 1 },
      },
      warnings: [],
    },
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
    ...(input.requestInput === true && { capabilities: { requestInput: true } }),
    handleEvent: async (event) => {
      events.push(event);
    },
    resolveModel: async () => model,
    tools: new Map([
      ["deploy", deploy],
      ...(input.tools ?? []).map((tool) => [tool.name, tool] as const),
    ]),
  };
  const ctx = createApprovalContext();
  const runStep = createToolLoopHarness(config);
  /** Runs a step and every step it schedules, as the session does within a turn. */
  const step = async (
    session: HarnessSession,
    stepInput?: StepInput,
    authorizationCallbacks?: ToolLoopHarnessConfig["authorizationCallbacks"],
  ): Promise<StepResult> => {
    // The session builds each step's harness, and only the first carries the
    // delivery's callbacks.
    const first =
      authorizationCallbacks === undefined
        ? runStep
        : createToolLoopHarness({ ...config, authorizationCallbacks });
    let result = await contextStorage.run(ctx, () => first(session, stepInput));
    while (typeof result.next === "function") {
      const { session: current } = result;
      const next = first === runStep ? result.next : runStep;
      result = await contextStorage.run(ctx, () => next(current));
    }
    return result;
  };
  /** A manual compaction (`control: "compact"`), summarized by its own model. */
  const compact = async (session: HarnessSession): Promise<StepResult> => {
    const summarizer = new MockLanguageModelV4({
      doGenerate: {
        content: [{ text: "Alice asked to deploy the api service.", type: "text" }],
        finishReason: { raw: undefined, unified: "stop" },
        usage: {
          inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
          outputTokens: { reasoning: undefined, text: 1, total: 1 },
        },
        warnings: [],
      },
      modelId: "approval-model",
      provider: "eve-integration-mock",
    });
    const runCompaction = createToolLoopHarness({
      ...config,
      compactOnly: true,
      resolveModel: async () => summarizer,
    });
    return await contextStorage.run(ctx, () => runCompaction(session));
  };
  const session: HarnessSession = {
    agent: { modelReference: { id: "approval-model" }, system: "Help Alice release.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:approval-session",
    history: [],
    sessionId: "generate-approval-resume-session",
  };
  /** Delivers the authorization callbacks with the next step, as the session does. */
  const signedIn = (attemptId: string): ToolLoopHarnessConfig["authorizationCallbacks"] => [
    { attemptId, connectionName: "release-service" },
  ];
  /** Runs one step alone, without the steps it schedules. */
  const stepOnce = async (session: HarnessSession, stepInput?: StepInput): Promise<StepResult> =>
    await contextStorage.run(ctx, () => runStep(session, stepInput));
  return {
    compact,
    context: ctx,
    events,
    execute,
    model,
    responses,
    session,
    signedIn,
    step,
    stepOnce,
  };
}

type Prompt = MockLanguageModelV4["doStreamCalls"][number]["prompt"];

/**
 * The calls a prompt or history leaves without a result, and the results
 * without a call before them: what providers reject.
 */
function unpairedCalls(messages: Prompt | readonly ModelMessage[]): string[] {
  const called = new Set<string>();
  const answered = new Set<string>();
  const unpaired: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call") called.add(part.toolCallId);
      if (part.type === "tool-result") {
        if (!called.has(part.toolCallId)) unpaired.push(`result without call: ${part.toolCallId}`);
        answered.add(part.toolCallId);
      }
    }
  }
  for (const id of called) if (!answered.has(id)) unpaired.push(`call without result: ${id}`);
  return unpaired;
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
  it("keeps the turn waiting without calling the model, then runs the approved call in eve", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall()), textStreamResult("Deployed api.")],
      tool: { approval: always() },
    });

    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });

    expect(held.waiting).toEqual({ kind: "input" });
    expect(fixture.model.doStreamCalls).toHaveLength(1);
    expect(fixture.events.at(-1)).toMatchObject({ data: { on: "input" }, type: "turn.waiting" });
    // The waiting call stays in history without a result, and no approval part enters it.
    // The asking step waits out of history until its call has a result.
    expect(partTypes(held.session.history)).toEqual(["user:text"]);

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
    expect(unpairedCalls(fixture.model.doStreamCalls[1]!.prompt)).toEqual([]);
    expect(partTypes(resumed.session.history)).toEqual([
      "user:text",
      "assistant:tool-call",
      "tool:tool-result",
      "assistant:text",
    ]);
  });

  it("runs the approved call as a step without a model call, then reads Alice's message after its result", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall()), textStreamResult("Deployed; notes sent.")],
      tool: { approval: always() },
    });
    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });
    const [request] = requested(fixture.events);

    const ran = await fixture.stepOnce(held.session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
      message: "Then send the release notes.",
    });

    // The call ran, its step joined history, and the model wasn't called.
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.model.doStreamCalls).toHaveLength(1);
    expect(typeof ran.next).toBe("function");
    expect(partTypes(ran.session.history)).toEqual([
      "user:text",
      "assistant:tool-call",
      "tool:tool-result",
    ]);
    expect(JSON.stringify(ran.session.history)).not.toContain("release notes");

    const start = fixture.events.length;
    const next = ran.next as StepFn;
    const answered = await contextStorage.run(createApprovalContext(), () => next(ran.session));

    // The next step is the model's: it reads the paired call, then the message.
    expect(answered.next).toBeNull();
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.model.doStreamCalls).toHaveLength(2);
    const prompt = fixture.model.doStreamCalls[1]!.prompt;
    expect(unpairedCalls(prompt)).toEqual([]);
    const text = JSON.stringify(prompt);
    expect(text.indexOf("deployed")).toBeGreaterThan(-1);
    expect(text.indexOf("Then send the release notes.")).toBeGreaterThan(text.indexOf("deployed"));
    // Its receipt went out with the step that read it.
    expect(fixture.events.slice(start).map((event) => event.type)).not.toContain(
      "message.received",
    );
    expect(fixture.events.slice(0, start)).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({ message: "Then send the release notes." }),
        type: "message.received",
      }),
    );
    expect(partTypes(answered.session.history)).toEqual([
      "user:text",
      "assistant:tool-call",
      "tool:tool-result",
      "assistant:text",
      "user:text",
      "assistant:text",
    ]);
  });

  it("reports Alice's typed approval received once, in the step that runs the call, and keeps it from the model", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall()), textStreamResult("Deployed api.")],
      tool: { approval: always() },
    });
    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });
    const received = () => fixture.events.filter((event) => event.type === "message.received");
    const before = received().length;

    const ran = await fixture.stepOnce(held.session, { message: "approve" });

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.model.doStreamCalls).toHaveLength(1);
    expect(received().slice(before)).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ message: "approve" }) }),
    ]);

    const answered = await contextStorage.run(createApprovalContext(), () =>
      (ran.next as StepFn)(ran.session),
    );

    expect(fixture.model.doStreamCalls).toHaveLength(2);
    expect(received().slice(before)).toHaveLength(1);
    expect(JSON.stringify(fixture.model.doStreamCalls[1]!.prompt)).not.toContain('"approve"');
    expect(partTypes(answered.session.history)).toEqual([
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
    expect(again.waiting).toBeUndefined();
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
    // The asking step waits with its runtime call, out of history.
    expect(partTypes(dispatched.session.history)).toEqual(["user:text"]);
    const humanInput = HumanInput.read(dispatched.session.state);
    expect(partTypes([...humanInput.heldMessages()])).toEqual(["assistant:tool-call"]);
    expect(humanInput.runtimeCalls()?.tasks.map((task) => task.callId)).toEqual(["call-1"]);
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
    expect(unpairedCalls(fixture.model.doStreamCalls[1]!.prompt)).toEqual([]);
  });

  it("holds a runtime call that settles beside an open approval until the approval resolves", async () => {
    const build: HarnessToolDefinition = {
      description: "Build a service.",
      inputSchema: jsonSchema({ type: "object" }),
      name: "build",
      workflowId: "workflow//./agent/tools/build//execute",
    };
    const fixture = setup({
      responses: [
        toolCallsStreamResult([
          deployCall("call-deploy"),
          { input: "{}", toolCallId: "call-build", toolName: "build" },
        ]),
        textStreamResult("Built; Alice declined the deploy."),
      ],
      tool: { approval: always() },
      tools: [build],
    });
    const held = await fixture.step(fixture.session, { message: "Build and deploy the api." });
    const [request] = requested(fixture.events);

    expect(partTypes(held.session.history)).toEqual(["user:text"]);
    const built = await fixture.step(held.session, {
      runtimeActionResults: [
        { callId: "call-build", kind: "tool-result", output: "built", toolName: "build" },
      ],
    });

    // The build has its result, but the deploy waits, so neither joins history.
    expect(built.next).toBeNull();
    expect(partTypes(built.session.history)).toEqual(["user:text"]);
    expect(fixture.model.doStreamCalls).toHaveLength(1);

    const declined = await fixture.step(built.session, {
      inputResponses: [{ optionId: "cancel", requestId: request!.requestId }],
    });

    expect(unpairedCalls(fixture.model.doStreamCalls[1]!.prompt)).toEqual([]);
    expect(partTypes(declined.session.history)).toEqual([
      "user:text",
      "assistant:tool-call",
      "assistant:tool-call",
      "tool:tool-result",
      "tool:tool-result",
      "assistant:text",
    ]);
  });

  it("keeps the asking step out of history while the turn waits", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall())],
      tool: { approval: always() },
    });

    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });

    expect(held.next).toBeNull();
    expect(partTypes(held.session.history)).toEqual(["user:text"]);
    expect(unpairedCalls(held.session.history)).toEqual([]);
  });

  it("sends the provider a valid prompt when Alice steers past the approval", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall()), textStreamResult("The draft is ready.")],
      tool: { approval: always() },
    });
    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });

    const steered = await fixture.step(held.session, { message: "Skip that; is the draft ready?" });

    expect(unpairedCalls(fixture.model.doStreamCalls[1]!.prompt)).toEqual([]);
    expect(unpairedCalls(steered.session.history)).toEqual([]);
  });

  it("compacts a held session without leaving the waiting call behind, then resumes it", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall()), textStreamResult("Deployed the api.")],
      tool: { approval: always() },
    });
    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });
    const [request] = requested(fixture.events);

    const compacted = await fixture.compact(held.session);

    expect(fixture.events.map((event) => event.type)).toContain("compaction.completed");
    expect(unpairedCalls(compacted.session.history)).toEqual([]);

    const resumed = await fixture.step(compacted.session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
    });

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(unpairedCalls(fixture.model.doStreamCalls[1]!.prompt)).toEqual([]);
    expect(unpairedCalls(resumed.session.history)).toEqual([]);
    expect(partTypes(resumed.session.history).slice(-3)).toEqual([
      "assistant:tool-call",
      "tool:tool-result",
      "assistant:text",
    ]);
  });

  it("counts the approved call and its result when checking for compaction before the model reads them", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall()), textStreamResult("Deployed the api.")],
      tool: { approval: always() },
    });
    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });
    const [request] = requested(fixture.events);

    // The last model call reported 1000 tokens for the one message it read; the
    // threshold leaves no room for the held step's call and result once they join history.
    const known = {
      lastKnownInputTokens: 1000,
      lastKnownPromptMessageCount: 1,
      recentWindowSize: 10,
    };
    let threshold = known.lastKnownInputTokens;
    while (shouldCompact(held.session.history, { ...known, threshold })) threshold++;
    const session = { ...held.session, compaction: { ...known, threshold } };

    const resumed = await fixture.step(session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
    });

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.events.map((event) => event.type)).toContain("compaction.completed");
    expect(resumed.session.history[0]).toMatchObject({ kind: "context.compaction", role: "user" });
    expect(unpairedCalls(fixture.model.doStreamCalls[1]!.prompt)).toEqual([]);
    expect(unpairedCalls(resumed.session.history)).toEqual([]);
  });
});

/** The authorization `probe` asks for: Alice's access to the release service. */
function authorization(attemptId: string) {
  return requestAuthorization([
    {
      attemptId,
      challenge: { url: `https://idp.example/authorize/${attemptId}` },
      hookUrl: `https://agent.example/callback/${attemptId}`,
      name: "release-service",
    },
  ]);
}

function probeCall(callId = "call-probe") {
  return { input: "{}", toolCallId: callId, toolName: "probe" };
}

describe("a sign-in callback no tool consumes", () => {
  it("is handed to the step that received it only, never to a later step or turn", async () => {
    const seen: number[] = [];
    const peek: HarnessToolDefinition = {
      description: "Look at the sign-in results without completing them.",
      execute: async () => {
        seen.push(getAuthorizationResults().length);
        return { ok: true };
      },
      inputSchema: jsonSchema({ type: "object" }),
      name: "peek",
    };
    const probe: HarnessToolDefinition = {
      description: "Check Alice's access.",
      execute: async () => authorization("attempt-1"),
      inputSchema: jsonSchema({ type: "object" }),
      name: "probe",
    };
    const peekCall = (callId: string) => ({ input: "{}", toolCallId: callId, toolName: "peek" });
    const fixture = setup({
      responses: [
        toolCallStreamResult(probeCall()),
        // The step the callback arrives with, then the next step of that turn.
        toolCallStreamResult(peekCall("call-peek-1")),
        toolCallStreamResult(peekCall("call-peek-2")),
        textStreamResult("Signed in."),
        // A later turn.
        toolCallStreamResult(peekCall("call-peek-3")),
        textStreamResult("Done."),
      ],
      tool: {},
      tools: [probe, peek],
    });

    const held = await fixture.step(fixture.session, { message: "Check my access." });
    expect(held.waiting).toEqual({ kind: "input" });

    const signedIn = await fixture.step(held.session, undefined, [
      {
        attemptId: "attempt-1",
        callback: { method: "GET", params: { code: "alice-code" } },
        connectionName: "release-service",
      },
    ]);
    expect(seen).toEqual([1, 0]);
    expect(fixture.context.has(PendingAuthorizationResultKey)).toBe(false);
    expect([...fixture.context.entries()].map(([key]) => key.name)).not.toContain(
      PendingAuthorizationResultKey.name,
    );

    await fixture.step(signedIn.session, { message: "Anything else?" });
    expect(seen).toEqual([1, 0, 0]);
  });
});

describe("an authorization beside a tool approval in the tool loop (real AI SDK)", () => {
  /** A tool whose call needs Alice to authorize before it can run. */
  const probe: HarnessToolDefinition = {
    description: "Check Alice's access.",
    execute: async () => authorization("attempt-1"),
    inputSchema: jsonSchema({ type: "object" }),
    name: "probe",
  };
  /** One step checks Alice's access (an authorization) and asks to deploy (an approval). */
  const checkAndDeploy = () => toolCallsStreamResult([probeCall(), deployCall()]);

  it("keeps the turn waiting on both without writing either waiting call to history", async () => {
    const fixture = setup({
      responses: [checkAndDeploy()],
      tool: { approval: always() },
      tools: [probe],
    });

    const held = await fixture.step(fixture.session, { message: "Check my access, then deploy." });

    expect(held.waiting).toEqual({ kind: "input" });
    const types = fixture.events.map((event) => event.type);
    expect(types).toContain("input.requested");
    expect(types).toContain("authorization.required");
    expect(types.at(-1)).toBe("turn.waiting");
    expect(partTypes(held.session.history)).toEqual(["user:text"]);
    expect(unpairedCalls(held.session.history)).toEqual([]);
  });

  it("sends the provider a valid prompt when Alice steers past the approval", async () => {
    const fixture = setup({
      responses: [checkAndDeploy(), textStreamResult("Skipping the deploy.")],
      tool: { approval: always() },
      tools: [probe],
    });
    const held = await fixture.step(fixture.session, { message: "Check my access, then deploy." });

    const steered = await fixture.step(held.session, { message: "Skip that; is the draft ready?" });

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(unpairedCalls(fixture.model.doStreamCalls[1]!.prompt)).toEqual([]);
    expect(unpairedCalls(steered.session.history)).toEqual([]);
    // The step joins history without the probe, and with a not-run result for the deploy.
    expect(partTypes(steered.session.history).slice(0, 3)).toEqual([
      "user:text",
      "assistant:tool-call",
      "tool:tool-result",
    ]);
    expect(JSON.stringify(steered.session.history)).not.toContain("call-probe");
  });

  it("compacts the held session without leaving a waiting call behind, then resumes it", async () => {
    const fixture = setup({
      responses: [checkAndDeploy(), textStreamResult("Deployed the api.")],
      tool: { approval: always() },
      tools: [probe],
    });
    const held = await fixture.step(fixture.session, { message: "Check my access, then deploy." });
    const [request] = requested(fixture.events);

    const compacted = await fixture.compact(held.session);

    expect(fixture.events.map((event) => event.type)).toContain("compaction.completed");
    expect(unpairedCalls(compacted.session.history)).toEqual([]);

    const approved = await fixture.step(compacted.session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
    });

    // The deploy runs, and the turn still waits on the authorization.
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(approved.waiting).toEqual({ kind: "input" });
    expect(fixture.model.doStreamCalls).toHaveLength(1);
    expect(unpairedCalls(approved.session.history)).toEqual([]);

    const steered = await fixture.step(approved.session, { message: "Skip the access check." });

    expect(unpairedCalls(fixture.model.doStreamCalls[1]!.prompt)).toEqual([]);
    expect(unpairedCalls(steered.session.history)).toEqual([]);
    expect(JSON.stringify(steered.session.history)).toContain("deployed");
  });

  it("hands a sign-in that completed before the approval to the call once the approval settles", async () => {
    const seen: number[] = [];
    const checking: HarnessToolDefinition = {
      ...probe,
      execute: async () => {
        const results = getAuthorizationResults();
        seen.push(results.length);
        return results.length > 0 ? { ok: true } : authorization("attempt-1");
      },
    };
    const fixture = setup({
      responses: [
        checkAndDeploy(),
        toolCallStreamResult(probeCall("call-probe-2")),
        textStreamResult("Checked and deployed."),
      ],
      tool: { approval: always() },
      tools: [checking],
    });
    const held = await fixture.step(fixture.session, { message: "Check my access, then deploy." });
    const [request] = requested(fixture.events);

    // The sign-in arrives first; the approval keeps the turn waiting.
    const signedIn = await fixture.step(held.session, undefined, [
      {
        attemptId: "attempt-1",
        callback: { method: "GET", params: { code: "alice-code" } },
        connectionName: "release-service",
      },
    ]);
    expect(signedIn.waiting).toEqual({ kind: "input" });
    expect(fixture.model.doStreamCalls).toHaveLength(1);

    const approved = await fixture.step(signedIn.session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
    });

    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(seen).toEqual([0, 1]);
    expect(approved.waiting).toBeUndefined();
    expect(fixture.context.has(PendingAuthorizationResultKey)).toBe(false);
  });

  it("hands a sign-in to the call only once the budget question it waited behind is answered", async () => {
    const seen: number[] = [];
    const checking: HarnessToolDefinition = {
      ...probe,
      execute: async () => {
        const results = getAuthorizationResults();
        seen.push(results.length);
        return results.length > 0 ? { ok: true } : authorization("attempt-1");
      },
    };
    const fixture = setup({
      requestInput: true,
      responses: [
        toolCallStreamResult(probeCall()),
        toolCallStreamResult(probeCall("call-probe-2")),
        textStreamResult("Checked."),
      ],
      tool: {},
      tools: [checking],
    });
    const held = await fixture.step(fixture.session, { message: "Check my access." });
    expect(held.waiting).toEqual({ kind: "input" });

    // The sign-in arrives over budget: the budget question parks the turn first.
    const overBudget = { ...held.session, limits: { maxInputTokensPerSession: 1 } };
    const start = fixture.events.length;
    const asked = await fixture.step(overBudget, undefined, [
      {
        attemptId: "attempt-1",
        callback: { method: "GET", params: { code: "alice-code" } },
        connectionName: "release-service",
      },
    ]);
    expect(asked.waiting).toEqual({ kind: "input" });
    expect(fixture.model.doStreamCalls).toHaveLength(1);
    const [budget] = requested(fixture.events.slice(start));
    expect(budget).toBeDefined();

    await fixture.step(asked.session, {
      inputResponses: [{ optionId: "continue", requestId: budget!.requestId }],
    });

    expect(seen).toEqual([0, 1]);
    expect(fixture.context.has(PendingAuthorizationResultKey)).toBe(false);
  });

  it("keeps an approved call that asks for an authorization out of history, and steers past it cleanly", async () => {
    const fixture = setup({
      responses: [toolCallStreamResult(deployCall()), textStreamResult("Skipping the deploy.")],
      tool: { approval: always(), execute: async () => authorization("attempt-2") },
    });
    const held = await fixture.step(fixture.session, { message: "Deploy the api service." });
    const [request] = requested(fixture.events);
    const start = fixture.events.length;

    const authorizing = await fixture.step(held.session, {
      inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
    });

    expect(authorizing.waiting).toEqual({ kind: "input" });
    const types = fixture.events.slice(start).map((event) => event.type);
    expect(types).toContain("authorization.required");
    expect(types.at(-1)).toBe("turn.waiting");
    expect(fixture.model.doStreamCalls).toHaveLength(1);
    // The call that asked leaves the step; nothing of it is in history.
    expect(partTypes(authorizing.session.history)).toEqual(["user:text"]);

    const steered = await fixture.step(authorizing.session, { message: "Never mind." });

    expect(unpairedCalls(fixture.model.doStreamCalls[1]!.prompt)).toEqual([]);
    expect(unpairedCalls(steered.session.history)).toEqual([]);
  });
});

/**
 * A step whose calls wait on a person and on runtime work at once: `build` is
 * a workflow tool, which runs in the session while the person answers. The
 * step waits out of history until every call it made has a result.
 */
describe("runtime calls beside a person in the tool loop (real AI SDK)", () => {
  const build: HarnessToolDefinition = {
    description: "Build a service.",
    inputSchema: jsonSchema({ type: "object" }),
    name: "build",
    workflowId: "workflow//./agent/tools/build//execute",
  };
  const probe: HarnessToolDefinition = {
    description: "Check Alice's access.",
    execute: async () => authorization("attempt-1"),
    inputSchema: jsonSchema({ type: "object" }),
    name: "probe",
  };
  const buildCall = { input: "{}", toolCallId: "call-build", toolName: "build" };
  const built = {
    runtimeActionResults: [
      { callId: "call-build", kind: "tool-result" as const, output: "built", toolName: "build" },
    ],
  };

  const mixes = {
    "an approval": { calls: [deployCall("call-deploy"), buildCall], person: "approval" },
    "an authorization": { calls: [probeCall(), buildCall], person: "authorization" },
    "an authorization and an approval": {
      calls: [probeCall(), deployCall("call-deploy"), buildCall],
      person: "both",
    },
  } as const;

  function start(mix: keyof typeof mixes, ...replies: string[]) {
    return setup({
      responses: [
        toolCallsStreamResult(mixes[mix].calls),
        ...replies.map((reply) => textStreamResult(reply)),
      ],
      tool: { approval: always() },
      tools: [build, probe],
    });
  }

  describe.each(Object.keys(mixes) as (keyof typeof mixes)[])("with %s", (mix) => {
    it("parks on the runtime call with the step out of history, then waits on the person", async () => {
      const fixture = start(mix);
      const parked = await fixture.step(fixture.session, { message: "Build and ship the api." });

      // The runtime call is dispatched even though a person is asked too.
      expect(parked.next).toBeNull();
      expect(parked.waiting).toBeUndefined();
      expect(partTypes(parked.session.history)).toEqual(["user:text"]);
      expect(HumanInput.read(parked.session.state).runtimeCalls()?.tasks).toEqual([
        expect.objectContaining({ callId: "call-build", kind: "workflow-task" }),
      ]);

      const onPerson = await fixture.step(parked.session, built);

      expect(onPerson.waiting).toEqual({ kind: "input" });
      expect(fixture.model.doStreamCalls).toHaveLength(1);
      expect(unpairedCalls(onPerson.session.history)).toEqual([]);
      expect(HumanInput.read(onPerson.session.state).runtimeCalls()).toBeUndefined();
    });

    it("resumes once the person answers, with every call answered once", async () => {
      const fixture = start(mix, "Shipped.");
      const parked = await fixture.step(fixture.session, { message: "Build and ship the api." });
      const onPerson = await fixture.step(parked.session, built);
      const [request] = requested(fixture.events);

      const resumed = await fixture.step(
        onPerson.session,
        mixes[mix].person === "authorization"
          ? undefined
          : { inputResponses: [{ optionId: "approve", requestId: request!.requestId }] },
        mixes[mix].person === "approval" ? undefined : fixture.signedIn("attempt-1"),
      );

      expect(fixture.model.doStreamCalls).toHaveLength(2);
      expect(unpairedCalls(fixture.model.doStreamCalls[1]!.prompt)).toEqual([]);
      expect(unpairedCalls(resumed.session.history)).toEqual([]);
      expect(JSON.stringify(resumed.session.history)).toContain("built");
      // The call that asked for an authorization left the step; the model calls it again.
      expect(JSON.stringify(resumed.session.history)).not.toContain("call-probe");
      expect(fixture.execute).toHaveBeenCalledTimes(mixes[mix].person === "authorization" ? 0 : 1);
    });

    it("steers past the person when Alice's message arrives with the runtime result", async () => {
      const fixture = start(mix, "Skipping that.");
      const parked = await fixture.step(fixture.session, { message: "Build and ship the api." });

      const steered = await fixture.step(parked.session, {
        ...built,
        message: "Skip the rest; is the build done?",
      });

      expect(fixture.execute).not.toHaveBeenCalled();
      expect(unpairedCalls(fixture.model.doStreamCalls[1]!.prompt)).toEqual([]);
      expect(unpairedCalls(steered.session.history)).toEqual([]);
      expect(JSON.stringify(steered.session.history)).toContain("built");
      expect(partTypes(steered.session.history).at(-1)).toBe("assistant:text");
    });

    it("compacts while parked without leaving a waiting call behind, then resumes", async () => {
      const fixture = start(mix, "Skipping that.");
      const parked = await fixture.step(fixture.session, { message: "Build and ship the api." });

      const compacted = await fixture.compact(parked.session);

      expect(fixture.events.map((event) => event.type)).toContain("compaction.completed");
      expect(unpairedCalls(compacted.session.history)).toEqual([]);
      expect(HumanInput.read(compacted.session.state).runtimeCalls()).toBeDefined();

      const onPerson = await fixture.step(compacted.session, built);
      expect(unpairedCalls(onPerson.session.history)).toEqual([]);
      const steered = await fixture.step(onPerson.session, { message: "Skip the rest." });

      expect(unpairedCalls(fixture.model.doStreamCalls[1]!.prompt)).toEqual([]);
      expect(unpairedCalls(steered.session.history)).toEqual([]);
    });
  });
});
