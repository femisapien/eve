import { jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { dispatchDynamicInstructionEvent } from "#context/dynamic-instruction-lifecycle.js";
import { SessionIdKey, StepDynamicToolMetadataKey } from "#context/keys.js";
import { getPendingAuthorization, requestAuthorization } from "#harness/authorization.js";
import { readTurnState, readyWorkflowCalls } from "#harness/turn-state.js";
import { stashToolInterrupt } from "#harness/tool-interrupts.js";
import { cancelTurn } from "#harness/session-lifecycle.js";
import { setTurnUsageState } from "#harness/turn-tag-state.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import {
  clearDurableDynamicCallbacks,
  registerDurableDynamicCallback,
} from "#tools/durable-callbacks.js";
import type { HarnessSession, StepInput } from "#harness/types.js";
import {
  answer,
  calls,
  inlineTool,
  requestIds,
  setup,
  text,
  toolCalls,
  toolResultIds,
  workflowTool,
} from "#internal/testing/tool-loop-fixture.js";
import { always } from "#tools/approval/policies.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

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
    // The stream says which turn runs the approved call, and which turn that one continues.
    const resumedEvents = fixture.events.slice(start);
    expect(resumedEvents.find((event) => event.type === "input.resolved")).toMatchObject({
      data: { resolutions: [{ outcome: "approved", resumeTurnId: "turn_1" }] },
    });
    expect(resumedEvents.find((event) => event.type === "turn.started")).toMatchObject({
      data: { continuesTurnId: "turn_0", turnId: "turn_1" },
    });
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
    const fixture = setup(
      [deploy],
      [
        calls("deploy"),
        toolCalls([{ callId: "call-bob", toolName: "deploy" }]),
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

    const start = fixture.events.length;
    const cleared = await fixture.step(parked.session, undefined, {
      ...fixture.config,
      clearOnly: true,
    });
    expect(readTurnState(cleared.session.state).steps).toEqual([]);
    // The call settles before its approval is withdrawn, where it was asked.
    expect(fixture.eventsSince(start).slice(0, 3)).toEqual([
      "action.result",
      "input.resolved",
      "context.cleared",
    ]);
    expect(fixture.events[start]).toMatchObject({
      data: { error: { code: "CONTEXT_CLEARED" }, status: "cancelled", turnId: "turn_0" },
    });

    await fixture.step(cleared.session, approval);
    expect(deploy.execute).not.toHaveBeenCalled();
  });

  it("settles an announced call that asks for a sign-in as cancelled, and names it on the sign-in", async () => {
    const signal = requestAuthorization([
      {
        attemptId: "attempt-lookup",
        challenge: { instructions: "Sign in to look up", url: "https://idp.example/auth" },
        hookUrl: "https://app.example/callback",
        name: "lookup",
        principal: { type: "app" },
      },
    ]);
    const interrupted = { ctx: undefined as ContextContainer | undefined };
    const lookup = {
      ...inlineTool(
        "lookup",
        vi.fn(async () => {
          stashToolInterrupt(interrupted.ctx!, "call-0", signal);
          return "sign-in required";
        }),
      ),
      approval: undefined,
    };
    const fixture = setup([lookup], [calls("lookup")]);
    interrupted.ctx = fixture.ctx;

    const parked = await fixture.step(fixture.session, { message: "Look up Bob's order." });

    expect(fixture.eventsSince(0)).toEqual(
      expect.arrayContaining(["action.result", "authorization.required", "turn.completed"]),
    );
    expect(fixture.events.find((event) => event.type === "action.result")).toMatchObject({
      data: { error: { code: "AUTHORIZATION_REQUIRED" }, status: "cancelled" },
    });
    expect(fixture.events.find((event) => event.type === "authorization.required")).toMatchObject({
      data: { attemptId: "attempt-lookup", callIds: ["call-0"] },
    });
    // The call leaves history, so the model calls the tool again after the sign-in.
    expect(toolResultIds(parked.session)).toEqual([]);
  });

  it("asks for the sign-in a call needs beside an approval, and parks the step without that call", async () => {
    const signal = requestAuthorization([
      {
        attemptId: "attempt-notes",
        challenge: { instructions: "Sign in to notes", url: "https://idp.example/auth" },
        hookUrl: "https://app.example/callback",
        name: "notes",
        principal: { type: "app" },
      },
    ]);
    const interrupted = { ctx: undefined as ContextContainer | undefined };
    const notes = {
      ...inlineTool(
        "notes",
        vi.fn(async () => {
          stashToolInterrupt(interrupted.ctx!, "call-1", signal);
          return "sign-in required";
        }),
      ),
      approval: undefined,
    };
    const fixture = setup([inlineTool("deploy"), notes], [calls("deploy", "notes")]);
    interrupted.ctx = fixture.ctx;

    const parked = await fixture.step(fixture.session, {
      message: "Read Bob's notes, then deploy.",
    });

    expect(fixture.events.find((event) => event.type === "authorization.required")).toMatchObject({
      data: { attemptId: "attempt-notes", callIds: ["call-1"] },
    });
    expect(getPendingAuthorization(parked.session.state)?.challenges).toMatchObject([
      { attemptId: "attempt-notes" },
    ]);
    expect(
      readTurnState(parked.session.state).steps.flatMap((step) =>
        step.calls.map((call) => call.callId),
      ),
    ).toEqual(["call-0"]);
  });

  it("keeps the turn for a running sibling when an approved call asks for a sign-in, then commits without it", async () => {
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
        stashToolInterrupt(interrupted.ctx!, "call-1", signal);
        return "sign-in required";
      }),
    );
    const research = { ...workflowTool("research"), approval: undefined };
    const fixture = setup([research, deploy], [calls("research", "deploy"), text("Findings in.")]);
    interrupted.ctx = fixture.ctx;
    const parked = await fixture.step(fixture.session, { message: "Research, then deploy." });

    // Alice approves with a note while the research run still works.
    const start = fixture.events.length;
    const approved = await fixture.step(parked.session, {
      ...answer(parked.session, "approve"),
      message: "Go ahead once it's ready.",
    });
    expect(fixture.eventsSince(start)).toContain("authorization.required");
    expect(fixture.eventsSince(start)).not.toContain("turn.completed");

    const researched = await fixture.step(approved.session, {
      runtimeActionResults: [
        { callId: "call-0", kind: "tool-result", output: "findings", toolName: "research" },
      ],
    });
    expect(toolResultIds(researched.session)).toEqual(["call-0"]);
    expect(JSON.stringify(fixture.doStream.mock.calls[1]![0].prompt)).not.toContain("call-1");
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
    // The sign-in is asked in the turn that runs the approved call.
    expect(getPendingAuthorization(resumed.session.state)).toEqual({
      challenges: signal.challenges.map((challenge) => ({
        ...challenge,
        origin: expect.objectContaining({ turnId: "turn_1" }),
      })),
    });
    // Like an inline call, the approved call leaves history and settles as cancelled.
    const resumedEvents = fixture.events.slice(start);
    expect(resumedEvents.find((event) => event.type === "action.result")).toMatchObject({
      data: {
        error: { code: "AUTHORIZATION_REQUIRED" },
        result: { callId: "call-0" },
        status: "cancelled",
        turnId: "turn_1",
      },
    });
    expect(resumedEvents.find((event) => event.type === "authorization.required")).toMatchObject({
      data: { callIds: ["call-0"], turnId: "turn_1" },
    });
    expect(fixture.doStream).toHaveBeenCalledOnce();
    expect(toolResultIds(resumed.session)).toEqual([]);
  });
});

/** Scenarios ported from the approval-gated workflow dispatch suite (#3983). */
describe("approved workflow calls (real AI SDK)", () => {
  const deployed = (callId = "call-0"): StepInput => ({
    runtimeActionResults: [{ callId, kind: "tool-result", output: "deployed", toolName: "deploy" }],
  });

  it("runs an approved workflow before the model reads the message sent with the approval", async () => {
    const fixture = setup([workflowTool("deploy")], [calls("deploy")]);
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });

    const start = fixture.events.length;
    const approved = await fixture.step(parked.session, {
      ...answer(parked.session, "approve"),
      message: "Tell Alice when deployment finishes.",
    });
    const resumedTurn = readTurnState(approved.session.state).turn?.id;
    expect(readyWorkflowCalls(readTurnState(approved.session.state))).toMatchObject([
      { callId: "call-0" },
    ]);
    expect(
      fixture.events.slice(start).filter((event) => event.type === "turn.started"),
    ).toMatchObject([{ data: { turnId: resumedTurn } }]);
    // The model reads nothing until the approved run finishes.
    expect(fixture.doStream).toHaveBeenCalledOnce();

    const completed = await fixture.step(approved.session, deployed());
    expect(toolResultIds(completed.session)).toEqual(["call-0"]);
    const prompt = JSON.stringify(fixture.doStream.mock.calls[1]![0].prompt);
    expect(prompt).toContain("deployed");
    expect(prompt).toContain("Tell Alice when deployment finishes.");
    expect(fixture.events.filter((event) => event.type === "input.resolved")).toHaveLength(1);
  });

  it("keeps an approved call runnable when the resumed turn adds user instructions", async () => {
    const fixture = setup([workflowTool("deploy")], [calls("deploy")], {
      handleEvent: async (event, messages) => {
        const ctx = contextStorage.getStore();
        if (!(ctx instanceof ContextContainer)) throw new Error("Missing test context.");
        await dispatchDynamicInstructionEvent({
          ctx,
          event,
          messages: messages ?? [],
          resolvers: [
            {
              eventNames: ["turn.started"],
              events: {
                "turn.started": () =>
                  defineInstructions({ role: "user", content: "Keep Alice informed." }),
              },
              logicalPath: "instructions/release.ts",
              slug: "release",
              sourceId: "instructions/release.ts",
              sourceKind: "module",
            },
          ],
        });
      },
    });
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    const approved = await fixture.step(parked.session, answer(parked.session, "approve"));
    expect(readyWorkflowCalls(readTurnState(approved.session.state))).toHaveLength(1);

    const completed = await fixture.step(approved.session, deployed());
    expect(toolResultIds(completed.session)).toEqual(["call-0"]);
    expect(JSON.stringify(fixture.doStream.mock.calls.at(-1)?.[0].prompt)).toContain(
      "Keep Alice informed.",
    );
  });

  it("never readies a workflow its policy denies, and reports it rejected", async () => {
    const fixture = setup(
      [{ ...workflowTool("deploy"), approval: () => "denied" as const }],
      [calls("deploy")],
    );
    const reviewed = await fixture.step(fixture.session, { message: "Review Alice's deployment." });

    expect(readyWorkflowCalls(readTurnState(reviewed.session.state))).toEqual([]);
    expect(requestIds(reviewed.session)).toEqual([]);
    expect(toolResultIds(reviewed.session)).toEqual(["call-0"]);
    expect(fixture.events.find((event) => event.type === "action.result")).toMatchObject({
      data: { result: { callId: "call-0" }, status: "rejected" },
    });
  });

  it("restores an approved dynamic sibling on a cold workflow continuation", async () => {
    const execute = vi.fn(async () => "notified");
    const preparedTurns: string[] = [];
    const fixture = setup(
      [
        workflowTool("deploy"),
        {
          approval: always(),
          description: "Notify Bob.",
          execute: async () => {
            throw new Error("The authored fallback must not execute.");
          },
          inputSchema: jsonSchema({ type: "object" }),
          name: "notify",
        },
      ],
      [calls("deploy", "notify")],
      {
        prepareApprovalTurn: async (event) => {
          preparedTurns.push(event.turnId);
        },
        resolveStepDynamicTools: async ({ ctx }) => {
          registerDurableDynamicCallback({
            callback: execute,
            owner: {
              entryKey: "notify",
              name: "notify",
              resolverSlug: "notifications",
              scope: "step",
              sessionId: ctx.require(SessionIdKey),
            },
            phase: "execute",
          });
          ctx.set(StepDynamicToolMetadataKey, [
            {
              callbacks: { execute: { closure: {} } },
              description: "Notify Bob.",
              entryKey: "notify",
              inputSchema: { type: "object" },
              name: "notify",
              resolverSlug: "notifications",
            },
          ]);
        },
      },
    );
    const parked = await fixture.step(fixture.session, {
      message: "Deploy Alice's release and notify Bob.",
    });
    const origin = readTurnState(parked.session.state).steps[0]!.origin.turnId;
    const approved = await fixture.step(parked.session, answer(parked.session, "approve"));
    clearDurableDynamicCallbacks(parked.session.sessionId);

    const completed = await fixture.step(
      JSON.parse(JSON.stringify(approved.session)) as HarnessSession,
      deployed(),
    );
    expect(preparedTurns.every((turnId) => turnId === origin)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(toolResultIds(completed.session)).toEqual(["call-0", "call-1"]);
    expect(JSON.stringify(completed.session.history)).toContain("notified");
    clearDurableDynamicCallbacks(parked.session.sessionId);
  });

  it("applies the session budget to the model call after an approved workflow", async () => {
    const fixture = setup([workflowTool("deploy")], [calls("deploy")]);
    const parked = await fixture.step(fixture.session, { message: "Deploy Alice's release." });
    const totals = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 12,
      outputTokens: 1,
      sawCost: false,
    };
    const exhausted = setTurnUsageState(
      { ...parked.session, limits: { maxInputTokensPerSession: 12 } },
      { ...totals, session: totals, turnId: "turn_0" },
    );
    const approved = await fixture.step(exhausted, answer(parked.session, "approve"));
    expect(readyWorkflowCalls(readTurnState(approved.session.state))).toMatchObject([
      { callId: "call-0" },
    ]);

    const limited = await fixture.step(approved.session, deployed());
    expect(toolResultIds(limited.session)).toEqual(["call-0"]);
    const limit = readTurnState(limited.session.state).prompt?.request;
    expect(limit?.kind).toBe("session-limit");

    const modelCalls = fixture.doStream.mock.calls.length;
    await fixture.step(limited.session, {
      inputResponses: [{ optionId: "continue", requestId: limit!.requestId }],
    });
    expect(fixture.doStream.mock.calls).toHaveLength(modelCalls + 1);
  });

  it("settles a running approved workflow as cancelled when its turn is cancelled", async () => {
    const execute = vi.fn(async () => "notified");
    const fixture = setup(
      [workflowTool("deploy"), inlineTool("notify", execute)],
      [calls("deploy", "notify")],
    );
    const parked = await fixture.step(fixture.session, {
      message: "Deploy Alice's release and notify Bob.",
    });
    const approved = await fixture.step(parked.session, answer(parked.session, "approve"));
    // The approved inline sibling runs at once; only the workflow is left running.
    expect(execute).toHaveBeenCalledOnce();

    const start = fixture.events.length;
    const cancelled = await contextStorage.run(fixture.ctx, () =>
      cancelTurn(fixture.config.handleEvent!, approved.session),
    );
    expect(toolResultIds(cancelled).sort()).toEqual(["call-0", "call-1"]);
    expect(
      fixture.events.slice(start).find((event) => event.type === "action.result"),
    ).toMatchObject({
      data: {
        error: { code: "TURN_CANCELLED" },
        result: { callId: "call-0" },
        status: "cancelled",
      },
    });

    await fixture.step(cancelled, {
      message: "Alice cancelled the release. Summarize the status.",
    });
    expect(execute).toHaveBeenCalledOnce();
  });
});
