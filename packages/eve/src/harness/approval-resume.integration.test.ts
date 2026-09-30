import { jsonSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import { SessionIdKey, StepDynamicToolMetadataKey } from "#context/keys.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { openApprovalRequests, readTurnState } from "#harness/turn-state.js";
import { setTurnUsageState } from "#harness/turn-tag-state.js";
import type { HarnessSession } from "#harness/types.js";
import {
  answer,
  requestIds,
  setup,
  text,
  toolCalls,
  toolResultIds,
  type ToolLoopFixture,
} from "#internal/testing/tool-loop-fixture.js";
import { always, once } from "#tools/approval/policies.js";
import {
  clearDurableDynamicCallbacks,
  registerDurableDynamicCallback,
} from "#tools/durable-callbacks.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

/**
 * Approval resumes ported from the suite the turn state replaced: approvals
 * answered together, `once()` grants, the session-limit prompt, a turn that
 * ran in between, and dynamic tools.
 */

function bash(approval: HarnessToolDefinition["approval"] = always()) {
  return {
    approval,
    description: "Run a shell command.",
    execute: vi.fn(async (input: unknown) => `ran ${(input as { command: string }).command}`),
    inputSchema: jsonSchema({ type: "object" }),
    name: "bash",
  } satisfies HarnessToolDefinition;
}

const run = (callId: string, command: string) => ({
  callId,
  input: { command },
  toolName: "bash",
});

/** Alice asks for one command, then another in a later turn, and both wait on approval. */
async function twoParkedSteps(fixture: ToolLoopFixture): Promise<HarnessSession> {
  const first = await fixture.drive(fixture.session, { message: "Run pwd." });
  const second = await fixture.drive(first.session, { message: "Also run whoami." });
  expect(requestIds(second.session)).toHaveLength(2);
  return second.session;
}

describe("approval resume (real AI SDK)", () => {
  it("runs two approvals answered together exactly once each", async () => {
    const tool = bash();
    const fixture = setup(
      [tool],
      [toolCalls([run("call-0", "pwd")]), toolCalls([run("call-1", "whoami")])],
    );
    const parked = await twoParkedSteps(fixture);

    const resumed = await fixture.drive(parked, answer(parked, "approve"));

    expect(tool.execute).toHaveBeenCalledTimes(2);
    expect(tool.execute.mock.calls.map(([input]) => input)).toEqual([
      { command: "pwd" },
      { command: "whoami" },
    ]);
    expect(toolResultIds(resumed.session)).toEqual(["call-0", "call-1"]);
  });

  it("keeps asking for a once() tool while an approval with its key still waits", async () => {
    const tool = bash(once());
    const fixture = setup(
      [tool],
      [
        toolCalls([run("call-0", "pwd")]),
        toolCalls([run("call-1", "whoami")]),
        toolCalls([run("call-2", "ls")]),
      ],
    );
    const parked = await twoParkedSteps(fixture);
    const [first] = openApprovalRequests(readTurnState(parked.state));

    const resumed = await fixture.drive(parked, {
      inputResponses: [{ optionId: "approve", requestId: first!.requestId }],
    });

    expect(tool.execute).toHaveBeenCalledOnce();
    expect(
      openApprovalRequests(readTurnState(resumed.session.state)).map(
        (request) => request.action.callId,
      ),
    ).toEqual(["call-1", "call-2"]);
  });

  it("allows a once() tool without asking after every approval with its key settles", async () => {
    const tool = bash(once());
    const fixture = setup(
      [tool],
      [
        toolCalls([run("call-0", "pwd")]),
        toolCalls([run("call-1", "whoami")]),
        toolCalls([run("call-2", "ls")]),
        text("All done."),
      ],
    );
    const parked = await twoParkedSteps(fixture);
    const [first, second] = openApprovalRequests(readTurnState(parked.state));
    const start = fixture.events.length;

    const resumed = await fixture.drive(parked, {
      inputResponses: [
        { optionId: "approve", requestId: first!.requestId },
        { optionId: "cancel", requestId: second!.requestId },
      ],
    });

    expect(fixture.eventsSince(start)).not.toContain("input.requested");
    expect(tool.execute.mock.calls.map(([input]) => input)).toEqual([
      { command: "pwd" },
      { command: "ls" },
    ]);
    expect(resumed.session.history.at(-1)).toMatchObject({
      content: [{ text: "All done.", type: "text" }],
      role: "assistant",
    });
  });

  it("runs an approved call, then holds the model on the session-limit prompt", async () => {
    const tool = bash();
    const fixture = setup(
      [tool],
      [toolCalls([run("call-0", "pwd")]), text("The command completed.")],
    );
    const parked = await fixture.drive(fixture.session, { message: "Run pwd." });
    const totals = {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      inputTokens: 12,
      outputTokens: 3,
      sawCost: false,
    };
    const exhausted = setTurnUsageState(
      { ...parked.session, limits: { maxInputTokensPerSession: 12 } },
      { ...totals, session: totals, turnId: "turn_0" },
    );

    const limited = await fixture.drive(exhausted, {
      ...answer(exhausted, "approve"),
      message: "Then summarize it.",
    });
    const limit = readTurnState(limited.session.state).prompt?.request;
    expect(limit?.kind).toBe("session-limit");
    // Running the approved call spends no model tokens; the budget holds the model call.
    expect(tool.execute).toHaveBeenCalledOnce();
    expect(fixture.doStream).toHaveBeenCalledOnce();

    await fixture.drive(limited.session, {
      inputResponses: [{ optionId: "continue", requestId: limit!.requestId }],
    });
    expect(tool.execute).toHaveBeenCalledOnce();
    const prompts = fixture.doStream.mock.calls
      .slice(1)
      .map(([options]) => JSON.stringify(options.prompt));
    expect(prompts.some((prompt) => prompt.includes("ran pwd"))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes("Then summarize it."))).toBe(true);
  });

  it("commits an approved step after the turn that ran while it waited", async () => {
    const tool = bash();
    const fixture = setup(
      [tool],
      [
        toolCalls([run("call-0", "pwd")]),
        text("Still waiting for approval to run pwd."),
        text("It printed ran pwd."),
      ],
    );
    const parked = await fixture.drive(fixture.session, { message: "Run pwd." });
    const intervening = await fixture.drive(parked.session, {
      message: "Any update on that command?",
    });

    const resumed = await fixture.drive(
      intervening.session,
      answer(intervening.session, "approve"),
    );

    expect(tool.execute).toHaveBeenCalledOnce();
    const prompt = JSON.stringify(fixture.doStream.mock.calls.at(-1)?.[0].prompt);
    expect(prompt.indexOf("Any update")).toBeGreaterThan(0);
    expect(prompt.indexOf("tool-call")).toBeGreaterThan(prompt.indexOf("Any update"));
    const history = JSON.stringify(resumed.session.history);
    expect(history.indexOf("Still waiting")).toBeLessThan(history.indexOf("ran pwd"));
    expect(toolResultIds(resumed.session)).toEqual(["call-0"]);
  });

  // From the #3494 diagnosis: an older approval must not stall a later turn's second step.
  it("runs a later turn past its tool step while an older approval waits", async () => {
    const gate = bash();
    const read = {
      description: "Read draft status",
      execute: vi.fn(async () => ({ status: "ready" })),
      inputSchema: jsonSchema({ type: "object" }),
      name: "read",
    } satisfies HarnessToolDefinition;
    const fixture = setup(
      [gate, read],
      [
        toolCalls([run("call-0", "chmod")]),
        toolCalls([{ callId: "call-1", toolName: "read" }]),
        text("Your draft is ready."),
      ],
    );
    const parked = await fixture.drive(fixture.session, {
      message: "Prepare the account change.",
    });
    const [approval] = openApprovalRequests(readTurnState(parked.session.state));

    const answered = await fixture.drive(parked.session, { message: "What is the draft status?" });

    expect(read.execute).toHaveBeenCalledOnce();
    expect(answered.settledTurn?.output).toBe("Your draft is ready.");
    expect(openApprovalRequests(readTurnState(answered.session.state))).toEqual([approval]);

    await fixture.drive(answered.session, answer(answered.session, "approve"));
    expect(gate.execute).toHaveBeenCalledOnce();
  });

  it.each(["structured", "text"] as const)(
    "grants a dynamic tool's own approval key on a %s approval",
    async (response) => {
      const execute = vi.fn(async () => "/workspace");
      const staticExecute = vi.fn(async () => "static");
      const fixture = setup(
        [{ ...bash(), execute: staticExecute }],
        [toolCalls([run("call-0", "pwd")])],
        {
          resolveStepDynamicTools: async ({ ctx }) => {
            const owner = {
              entryKey: "bash",
              name: "bash",
              resolverSlug: "dynamic-shell",
              scope: "step" as const,
              sessionId: ctx.require(SessionIdKey),
            };
            registerDurableDynamicCallback({ callback: execute, owner, phase: "execute" });
            registerDurableDynamicCallback({
              callback: (_closure, input: { command: string }) => `bash:${input.command}`,
              owner,
              phase: "approvalKey",
            });
            ctx.set(StepDynamicToolMetadataKey, [
              {
                callbacks: { approvalKey: { closure: {} }, execute: { closure: {} } },
                description: "Run a shell command.",
                entryKey: "bash",
                inputSchema: { type: "object" },
                name: "bash",
                resolverSlug: "dynamic-shell",
              },
            ]);
          },
        },
      );
      const parked = await fixture.drive(fixture.session, { message: "Run pwd." });

      const resumed = await fixture.drive(
        parked.session,
        response === "text" ? { message: "approve" } : answer(parked.session, "approve"),
      );

      expect(readTurnState(resumed.session.state).grants).toEqual(["bash:pwd"]);
      expect(execute).toHaveBeenCalledOnce();
      expect(staticExecute).not.toHaveBeenCalled();
      clearDurableDynamicCallbacks(fixture.session.sessionId);
    },
  );
});
