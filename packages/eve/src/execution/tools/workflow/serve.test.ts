import { expect, it, vi } from "vitest";

import type { SessionAuth, SessionContext, SessionTurn } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { readWorkflowToolRunRef } from "#execution/tools/workflow/ask.js";
import type { WorkflowBodyInput } from "#execution/tools/workflow/body.js";
import type {
  WorkflowBodyCommand,
  WorkflowToolRunMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { startServeBody } from "#execution/tools/workflow/serve.js";
import type { JsonValue } from "#shared/json.js";
import type {
  WorkflowServeCall,
  WorkflowServeContext,
  WorkflowServeReceive,
} from "#tools/workflow-definition.js";

const mocks = vi.hoisted(() => ({
  deliver: vi.fn<(inbox: string, message: WorkflowToolRunMessage) => Promise<void>>(),
  openAgent:
    vi.fn<
      (input: { readonly context: AgentSessionContext; readonly name: string }) => Promise<unknown>
    >(),
  sendAgent: vi.fn<(input: { readonly context: AgentSessionContext }) => Promise<void>>(),
  serve: vi.fn(),
}));
vi.mock("#execution/workflow-registry.js", () => ({ readRegisteredWorkflow: () => mocks.serve }));
vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({
  resumeHookStep: mocks.deliver,
}));
vi.mock("#execution/agent-sessions/steps.js", () => ({
  openAgentSessionStep: mocks.openAgent,
  sendAgentSessionMessageStep: mocks.sendAgent,
}));
vi.mock("#compiled/@workflow/core/index.js", () => ({
  // The agent's turn never reports; only how the session opened matters here.
  createHook: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    token: "agent-turn",
  }),
}));

/** Alice, with the claims she has when she makes a call. */
function alice(role: string): SessionAuth {
  return {
    current: {
      attributes: { role },
      authenticator: "test",
      principalId: "alice",
      principalType: "user",
    },
    initiator: null,
  };
}

const reviewer = { description: "Review the plan." };
/** A dynamic agent the turn of a later call selected. */
const releaseCaptain = { description: "Coordinate the release." };

/** The context the session captured for a call, which sessions opened for it inherit. */
function agentContext(
  callId: string,
  turn: SessionTurn,
  agents: AgentSessionContext["agents"],
): AgentSessionContext {
  return {
    agents,
    capabilities: { requestInput: true },
    parent: { callId, rootSessionId: "session", sessionId: "session", turn },
  } as AgentSessionContext;
}

const input: WorkflowBodyInput = {
  agentContext: agentContext("call-1", { id: "turn", sequence: 1 }, { reviewer }),
  callId: "call-1",
  entry: { entryPoint: "serve", taskId: "plan-7k2m9q" },
  input: { request: "Draft the plan." },
  hookToken: "control",
  owner: { send: (message) => mocks.deliver("inbox", message), sent: 0 },
  runId: "run",
  session: {
    auth: alice("editor"),
    id: "session",
    turn: { id: "turn", sequence: 1 },
  },
  stepIndex: 0,
  toolName: "plan",
  workflowId: "workflow//test//plan",
};

/** A later call, made in its own turn, by Alice with the claims she has by then. */
function call(callId: string, request: string): WorkflowBodyCommand {
  const turn = { id: `turn-${callId}`, sequence: 2 };
  return {
    call: {
      agentContext: agentContext(callId, turn, { "release-captain": releaseCaptain, reviewer }),
      auth: alice("reviewer"),
      callId,
      input: { request },
      sequence: turn.sequence,
      stepIndex: 0,
      turnId: turn.id,
    },
    kind: "call",
  };
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve()));
}

it("serves every call to its task, one stretch of work at a time, until the session ends", async () => {
  const received: WorkflowServeCall<JsonValue>[] = [];
  const pendings: Promise<WorkflowServeCall<JsonValue>>[] = [];
  let servingSecond:
    | {
        agents: WorkflowServeContext["agents"];
        ref: WorkflowToolRunRef;
        session: SessionContext["session"];
      }
    | undefined;
  mocks.serve.mockImplementation(
    async (receive: WorkflowServeReceive<JsonValue>, ctx: WorkflowServeContext<JsonValue>) => {
      received.push(await receive());
      const review = ctx.agent("reviewer");
      await review.send("Review the draft.");
      const pending = receive();
      pendings.push(pending, receive());
      received.push(await pending);
      servingSecond = {
        agents: ctx.agents,
        ref: readWorkflowToolRunRef(ctx as never),
        session: ctx.session,
      };
      await review.send("Check the rollback step.");
      await ctx.agent("release-captain").send("Schedule the rollback drill.");
      ctx.reply("revised plan");
      const third = await receive();
      received.push(third);
      await aborted(third.abortSignal);
      received.push(await receive());
      return await receive();
    },
  );
  mocks.openAgent.mockImplementation(async ({ name }) => ({
    kind: "local",
    name,
    nodeId: name,
    sessionId: `${name}-session`,
  }));
  const started = startServeBody(input);

  await vi.waitFor(() => expect(pendings).toHaveLength(2));
  started.control.apply(call("call-2", "Add a rollback step."));
  await vi.waitFor(() => expect(mocks.deliver).toHaveBeenCalledTimes(4));
  started.control.apply(call("call-3", "Move it to Friday."));
  await vi.waitFor(() => expect(received).toHaveLength(3));
  started.control.apply({ kind: "cancel", reason: "The task was cancelled." });
  started.control.apply(call("call-4", "Keep it on Thursday."));
  await vi.waitFor(() => expect(received).toHaveLength(4));
  started.control.apply({ kind: "end", reason: "The session ended." });

  await expect(started.outcome).resolves.toEqual({
    reason: "The session ended.",
    status: "cancelled",
  });
  expect(pendings[0]).toBe(pendings[1]);
  expect(received.map(({ callId, input }) => ({ callId, input }))).toEqual([
    { callId: "call-1", input: { request: "Draft the plan." } },
    { callId: "call-2", input: { request: "Add a rollback step." } },
    { callId: "call-3", input: { request: "Move it to Friday." } },
    { callId: "call-4", input: { request: "Keep it on Thursday." } },
  ]);
  const replies = mocks.deliver.mock.calls.flatMap(([inbox, message]) =>
    message.kind === "reply"
      ? [
          {
            callId: message.from.callId,
            inbox,
            output: message.output,
            turnId: message.from.turnId,
          },
        ]
      : [],
  );
  expect(replies).toEqual([
    { callId: "call-1", inbox: "inbox", output: "revised plan", turnId: "turn" },
    { callId: "call-2", inbox: "inbox", output: "revised plan", turnId: "turn-call-2" },
  ]);
  // Questions, sign-ins, `agent.started`, `ctx.session`, and `ctx.agents`
  // while serving a later call describe that call, not the call that started
  // the task.
  expect(servingSecond).toMatchObject({
    agents: { "release-captain": releaseCaptain, reviewer },
    ref: { callId: "call-2", taskId: "plan-7k2m9q", turnId: "turn-call-2" },
    session: { auth: alice("reviewer"), turn: { id: "turn-call-2", sequence: 2 } },
  });
  // A session is the child of the call served when it opened, and each
  // message to it carries the auth of the call served when it was sent.
  const firstCall = { callId: "call-1", turn: { id: "turn", sequence: 1 } };
  expect(mocks.openAgent.mock.calls.map(([opened]) => opened)).toMatchObject([
    { auth: alice("editor"), context: { parent: firstCall }, name: "reviewer" },
    {
      auth: alice("reviewer"),
      context: { parent: { callId: "call-2", turn: { id: "turn-call-2", sequence: 2 } } },
      name: "release-captain",
    },
  ]);
  expect(mocks.sendAgent.mock.calls.map(([sent]) => sent)).toMatchObject([
    {
      address: { sessionId: "reviewer-session" },
      auth: alice("reviewer"),
      context: { parent: firstCall },
      message: "Check the rollback step.",
    },
  ]);
  const [first, second, third, fourth] = received.map((served) => served.abortSignal);
  // A call that arrives while the task works joins its stretch; a cancel ends
  // only that stretch, and the next call starts a new one.
  expect(second).toBe(first);
  expect(third).not.toBe(first);
  expect(third?.aborted).toBe(true);
  expect(fourth).not.toBe(third);
  expect(first?.aborted).toBe(false);
  expect(fourth?.aborted).toBe(true);
});
