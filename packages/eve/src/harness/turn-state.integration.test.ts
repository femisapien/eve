import { jsonSchema, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { getPendingAuthorization, requestAuthorization } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { openApprovalRequests, readTurnState, readyWorkflowCalls } from "#harness/turn-state.js";
import { stashToolInterrupt } from "#harness/tool-interrupts.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, StepInput, ToolLoopHarnessConfig } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { always } from "#tools/approval/policies.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

function streamOf(chunks: StreamPart[], finish: "stop" | "tool-calls"): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        ...chunks,
        { finishReason: { raw: undefined, unified: finish }, type: "finish", usage },
      ],
    }),
  };
}

const text = (value: string) =>
  streamOf(
    [
      { id: "answer", type: "text-start" },
      { delta: value, id: "answer", type: "text-delta" },
      { id: "answer", type: "text-end" },
    ],
    "stop",
  );

const calls = (...toolNames: string[]) =>
  streamOf(
    toolNames.map((toolName, index) => ({
      input: JSON.stringify({ target: `${toolName}-${index}` }),
      toolCallId: `call-${index}`,
      toolName,
      type: "tool-call" as const,
    })),
    "tool-calls",
  );

function inlineTool(name: string, execute = vi.fn(async () => `${name} done`)) {
  return {
    approval: always(),
    description: name,
    execute,
    inputSchema: jsonSchema({ type: "object" }),
    name,
  } satisfies HarnessToolDefinition;
}

function workflowTool(name: string): HarnessToolDefinition {
  return {
    approval: always(),
    description: name,
    inputSchema: jsonSchema({ type: "object" }),
    name,
    workflowId: `workflow//./agent/tools/${name}//execute`,
  };
}

function setup(
  tools: readonly HarnessToolDefinition[],
  responses: readonly StreamResult[],
  overrides: Partial<ToolLoopHarnessConfig> = {},
) {
  const events: UnstampedMessageStreamEvent[] = [];
  const doStream = vi.fn<MockLanguageModelV4["doStream"]>();
  for (const response of responses) doStream.mockResolvedValueOnce(response);
  doStream.mockResolvedValue(text("Done."));
  const model = new MockLanguageModelV4({
    doStream,
    modelId: "turn-state-model",
    provider: "eve-integration-mock",
  });
  const config: ToolLoopHarnessConfig = {
    capabilities: { requestInput: true },
    handleEvent: async (event) => {
      events.push(event);
    },
    resolveModel: async () => model,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    ...overrides,
  };
  const ctx = new ContextContainer();
  const alice = {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId: "alice",
    principalType: "user" as const,
  };
  ctx.set(AuthKey, alice);
  ctx.set(SessionIdKey, "turn-state");
  ctx.set(SessionKey, {
    auth: { current: alice, initiator: alice },
    sessionId: "turn-state",
    turn: { id: "turn_0", sequence: 0 },
  });
  const session: HarnessSession = {
    agent: { modelReference: { id: "turn-state-model" }, system: "Help Alice.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:turn-state",
    history: [],
    sessionId: "turn-state",
  };
  const step = (current: HarnessSession, input?: StepInput, stepConfig = config) =>
    contextStorage.run(ctx, () => createToolLoopHarness(stepConfig)(current, input));
  const eventsSince = (start: number) => events.slice(start).map((event) => event.type);
  return { config, ctx, doStream, events, eventsSince, session, step };
}

function requestIds(session: HarnessSession): string[] {
  return openApprovalRequests(readTurnState(session.state)).map((request) => request.requestId);
}

function answer(session: HarnessSession, optionId: "approve" | "cancel"): StepInput {
  return {
    inputResponses: requestIds(session).map((requestId) => ({ optionId, requestId })),
  };
}

function toolResultIds(session: HarnessSession): string[] {
  return session.history.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
      : [],
  );
}

describe("turn state (real AI SDK)", () => {
  it("closes the turn on an approval, then runs the approved call once before the model reads it", async () => {
    const deploy = inlineTool("deploy");
    const fixture = setup([deploy], [calls("deploy")]);

    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });

    expect(parked.next).toBeNull();
    expect(deploy.execute).not.toHaveBeenCalled();
    expect(requestIds(parked.session)).toHaveLength(1);
    expect(fixture.eventsSince(0).slice(-3)).toEqual([
      "input.requested",
      "turn.completed",
      "session.waiting",
    ]);
    expect(readTurnState(parked.session.state).turn).toBeUndefined();

    const start = fixture.events.length;
    const resumed = await fixture.step(parked.session, answer(parked.session, "approve"));

    expect(deploy.execute).toHaveBeenCalledOnce();
    expect(resumed.next).toBeNull();
    expect(fixture.eventsSince(start)).toEqual(
      expect.arrayContaining(["turn.started", "input.resolved", "action.result", "step.started"]),
    );
    expect(fixture.eventsSince(start).at(-1)).toBe("session.waiting");
    expect(toolResultIds(resumed.session)).toEqual(["call-0"]);
    expect(JSON.stringify(fixture.doStream.mock.calls[1]![0].prompt)).toContain("deploy done");
    expect(readTurnState(resumed.session.state).steps).toEqual([]);
  });

  it("runs an approved call with the messages the model reads", async () => {
    const deploy = inlineTool("deploy");
    // A history projector, as compaction is, changes what the model and the call read.
    const fixture = setup([deploy], [calls("deploy")], {
      historyProjector: ({ messages }) =>
        messages.map((message) =>
          message.role === "user" ? { ...message, content: "Alice's request." } : message,
        ),
    });
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    await fixture.step(parked.session, answer(parked.session, "approve"));

    const messages = JSON.stringify(deploy.execute.mock.calls[0]?.at(1));
    expect(messages).toContain("Alice's request.");
    expect(messages).not.toContain("Deploy Alice's release.");
  });

  it("settles a denial without running the call, and reports it rejected", async () => {
    const deploy = inlineTool("deploy");
    const fixture = setup([deploy], [calls("deploy")]);
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });

    const start = fixture.events.length;
    const resumed = await fixture.step(parked.session, answer(parked.session, "cancel"));

    expect(deploy.execute).not.toHaveBeenCalled();
    expect(fixture.events.slice(start)).toContainEqual({
      data: expect.objectContaining({
        error: expect.objectContaining({ code: "TOOL_EXECUTION_DENIED" }),
        result: expect.objectContaining({ callId: "call-0" }),
        turnId: "turn_0",
      }),
      type: "action.result",
    });
    expect(toolResultIds(resumed.session)).toEqual(["call-0"]);
    expect(JSON.stringify(fixture.doStream.mock.calls[1]![0].prompt)).toContain("execution-denied");
  });

  it("resumes a step only once every approval it holds is decided", async () => {
    const review = inlineTool("review");
    const deploy = inlineTool("deploy");
    const fixture = setup([review, deploy], [calls("review", "deploy")]);
    const parked = await fixture.step(fixture.session, { message: "Review and deploy." });
    const [first, second] = requestIds(parked.session);

    const start = fixture.events.length;
    const partial = await fixture.step(parked.session, {
      inputResponses: [{ optionId: "approve", requestId: first! }],
    });

    expect(fixture.eventsSince(start)).not.toContain("turn.started");
    expect(fixture.eventsSince(start).at(-1)).toBe("session.waiting");
    expect(fixture.doStream).toHaveBeenCalledOnce();
    expect(review.execute).not.toHaveBeenCalled();

    const resumed = await fixture.step(partial.session, {
      inputResponses: [{ optionId: "approve", requestId: second! }],
    });

    expect(review.execute).toHaveBeenCalledOnce();
    expect(deploy.execute).toHaveBeenCalledOnce();
    expect(toolResultIds(resumed.session)).toEqual(["call-0", "call-1"]);
    expect(fixture.events.filter((event) => event.type === "input.resolved")).toHaveLength(1);
  });

  it("never readies a workflow call before a person approves it", async () => {
    const fixture = setup([workflowTool("deploy")], [calls("deploy")]);
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });

    expect(readyWorkflowCalls(readTurnState(parked.session.state))).toEqual([]);

    const denied = await fixture.step(parked.session, answer(parked.session, "cancel"));
    expect(readyWorkflowCalls(readTurnState(denied.session.state))).toEqual([]);
    expect(toolResultIds(denied.session)).toEqual(["call-0"]);
  });

  it("waits on an approved workflow call's run, then commits its result", async () => {
    const fixture = setup([workflowTool("deploy")], [calls("deploy")]);
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });

    const approved = await fixture.step(parked.session, answer(parked.session, "approve"));

    expect(approved.next).toBeNull();
    const turnState = readTurnState(approved.session.state);
    expect(turnState.turn).toBeDefined();
    expect(readyWorkflowCalls(turnState).map((call) => call.callId)).toEqual(["call-0"]);
    expect(fixture.doStream).toHaveBeenCalledOnce();

    const completed = await fixture.step(approved.session, {
      runtimeActionResults: [
        { callId: "call-0", kind: "tool-result", output: "deployed", toolName: "deploy" },
      ],
    });

    expect(toolResultIds(completed.session)).toEqual(["call-0"]);
    expect(JSON.stringify(fixture.doStream.mock.calls[1]![0].prompt)).toContain("deployed");
  });

  it("runs an ungated workflow sibling while its step's approval waits", async () => {
    const deploy = inlineTool("deploy");
    const research = { ...workflowTool("research"), approval: undefined };
    const fixture = setup([research, deploy], [calls("research", "deploy")]);

    const dispatched = await fixture.step(fixture.session, { message: "Research, then deploy." });

    expect(readyWorkflowCalls(readTurnState(dispatched.session.state))).toMatchObject([
      { callId: "call-0" },
    ]);
    expect(requestIds(dispatched.session)).toHaveLength(1);
    expect(fixture.eventsSince(0)).not.toContain("turn.completed");

    const start = fixture.events.length;
    const researched = await fixture.step(dispatched.session, {
      runtimeActionResults: [
        { callId: "call-0", kind: "tool-result", output: "findings", toolName: "research" },
      ],
    });

    // Only a person can answer the rest of the step, so the turn ends and
    // the step waits, uncommitted, for the approval.
    expect(fixture.eventsSince(start)).toEqual([
      "action.result",
      "turn.completed",
      "session.waiting",
    ]);
    expect(toolResultIds(researched.session)).toEqual([]);
    expect(fixture.doStream).toHaveBeenCalledOnce();

    const resumed = await fixture.step(researched.session, answer(researched.session, "approve"));

    expect(deploy.execute).toHaveBeenCalledOnce();
    expect(toolResultIds(resumed.session)).toEqual(["call-0", "call-1"]);
    expect(JSON.stringify(fixture.doStream.mock.calls[1]![0].prompt)).toContain("findings");
  });

  it("answers a new message while an approval stays open", async () => {
    const deploy = inlineTool("deploy");
    const fixture = setup([deploy], [calls("deploy"), text("Bob owns staging.")]);
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });

    const answered = await fixture.step(parked.session, { message: "Who owns staging?" });

    expect(fixture.doStream).toHaveBeenCalledTimes(2);
    expect(deploy.execute).not.toHaveBeenCalled();
    expect(requestIds(answered.session)).toEqual(requestIds(parked.session));
    expect(answered.settledTurn).toEqual({ output: "Bob owns staging." });
  });

  it("answers a repeated response to a settled approval as a message", async () => {
    const deploy = inlineTool("deploy");
    const bobCall = {
      input: "{}",
      toolCallId: "call-bob",
      toolName: "deploy",
      type: "tool-call" as const,
    };
    const fixture = setup(
      [deploy],
      [
        calls("deploy"),
        streamOf([bobCall], "tool-calls"),
        text("Bob's deployment is cancelled."),
        text("Bob's deployment stays cancelled."),
      ],
    );
    const alice = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    const both = await fixture.step(alice.session, { message: "Deploy Bob's release too." });
    const bob = requestIds(both.session)[1]!;
    const cancelBob = { inputResponses: [{ optionId: "cancel", requestId: bob }] };
    const cancelled = await fixture.step(both.session, cancelBob);

    const repeated = await fixture.step(cancelled.session, cancelBob);

    expect(fixture.doStream).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(fixture.doStream.mock.calls[3]![0].prompt)).toContain(
      "The user submitted the following response to an earlier interactive prompt.",
    );
    expect(repeated.settledTurn).toEqual({ output: "Bob's deployment stays cancelled." });
    expect(deploy.execute).not.toHaveBeenCalled();
    expect(requestIds(repeated.session)).toEqual(requestIds(alice.session));
  });

  it("revokes open approvals when the context is cleared", async () => {
    const deploy = inlineTool("deploy");
    const fixture = setup([deploy], [calls("deploy")]);
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    const approval = answer(parked.session, "approve");

    const cleared = await fixture.step(parked.session, undefined, {
      ...fixture.config,
      clearOnly: true,
    });
    expect(readTurnState(cleared.session.state).steps).toEqual([]);

    await fixture.step(cleared.session, approval);
    expect(deploy.execute).not.toHaveBeenCalled();
  });

  it("parks on the sign-in an approved call asks for", async () => {
    const signal = requestAuthorization([
      {
        attemptId: "attempt-deploy",
        challenge: { instructions: "Sign in to deploy", url: "https://idp.example/auth" },
        hookUrl: "https://app.example/callback",
        name: "deploy",
        principal: { type: "app" },
      },
    ]);
    const interrupted = { ctx: undefined as ContextContainer | undefined };
    const deploy = inlineTool(
      "deploy",
      vi.fn(async () => {
        stashToolInterrupt(interrupted.ctx!, "call-0", signal);
        return "sign-in required";
      }),
    );
    const fixture = setup([deploy], [calls("deploy")]);
    interrupted.ctx = fixture.ctx;
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });

    const start = fixture.events.length;
    const resumed = await fixture.step(parked.session, answer(parked.session, "approve"));

    expect(deploy.execute).toHaveBeenCalledOnce();
    expect(getPendingAuthorization(resumed.session.state)).toEqual({
      challenges: signal.challenges,
    });
    expect(fixture.eventsSince(start)).toContain("authorization.required");
    expect(fixture.eventsSince(start)).not.toContain("action.result");
    expect(fixture.doStream).toHaveBeenCalledOnce();
    expect(toolResultIds(resumed.session)).toEqual([]);
  });
});
