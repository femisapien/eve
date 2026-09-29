import { afterEach, expect, it, vi } from "vitest";

import type {
  SessionInbox,
  SessionInboxPayload,
  WorkflowToolRunAgentStarted,
} from "#execution/session-inbox/inbox.js";
import { SessionInputQueue } from "#execution/session/input-queue.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { SessionExecution } from "#execution/session/turn.js";
import { turnStep } from "#execution/session/turn-step.js";
import { publishWrittenEventsStep } from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { defineHook } from "#public/definitions/hook.js";
import { defineState } from "#public/definitions/state.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

vi.mock("#execution/session/turn-step.js", () => ({ turnStep: vi.fn() }));
vi.mock(
  "#execution/tools/workflow/emit-workflow-tool-run-report-step.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("#execution/tools/workflow/emit-workflow-tool-run-report-step.js")
      >();
    return { ...actual, publishWrittenEventsStep: vi.fn(actual.publishWrittenEventsStep) };
  },
);

afterEach(() => vi.clearAllMocks());

const STEP_MARKER = "test.step";
const stepMarker = defineState<string>(STEP_MARKER, () => "before the step");
const audit = defineState<string[]>("test.agent-started-audit", () => []);

it("keeps the state an agent.started hook writes while a model step runs", async () => {
  const hooked: { event: MessageStreamEvent; sawStep: string }[] = [];
  const session = await createSession(
    defineHook({
      events: {
        "agent.started"(event) {
          hooked.push({ event, sawStep: stepMarker.get() });
          audit.update((ids) => [...ids, event.data.sessionId]);
        },
      },
    }),
  );

  await session.runTurn(async (inbox) => {
    inbox.arrive(agentStarted("child-1"));
    inbox.arrive(agentStarted("child-2"));
    // Clients follow a child from its agent.started, so it is written before the step ends.
    await vi.waitFor(() => expect(session.agentStartedIds()).toEqual(["child-1", "child-2"]));
    // The pump accepts this one only after the step ends.
    return () => inbox.enqueue(agentStarted("child-3"));
  });

  const children = ["child-1", "child-2", "child-3"];
  expect(session.agentStartedIds()).toEqual(children);
  expect(hooked).toEqual(
    session.streamed
      .filter((event) => event.type === "agent.started")
      .map((event) => ({ event, sawStep: "after the step" })),
  );
  expect(session.cursor.serializedContext).toMatchObject({
    [STEP_MARKER]: "after the step",
    "test.agent-started-audit": children,
  });
  // The events written during the step share one boundary step.
  expect(publishWrittenEventsStep).toHaveBeenCalledTimes(1);
});

it("publishes agent.started completely during the step when nothing subscribes to it", async () => {
  const session = await createSession();

  await session.runTurn(async (inbox) => {
    inbox.arrive(agentStarted("child-1"));
    await vi.waitFor(() => expect(session.agentStartedIds()).toEqual(["child-1"]));
  });

  expect(session.agentStartedIds()).toEqual(["child-1"]);
  expect(publishWrittenEventsStep).not.toHaveBeenCalled();
});

function agentStarted(sessionId: string): WorkflowToolRunAgentStarted {
  return {
    from: {
      callId: `call-${sessionId}`,
      input: {},
      runId: `run-${sessionId}`,
      sequence: 1,
      stepIndex: 0,
      taskId: `task-${sessionId}`,
      toolName: "reviewer",
      turnId: "turn_0",
    },
    kind: "agent-started",
    session: { kind: "local", name: "reviewer", nodeId: "reviewer", sessionId },
  };
}

/** An inbox that, like the real one, replays unread `agent-started` messages on subscription. */
function createInbox() {
  const queue: SessionInboxPayload[] = [];
  const agentStartedHandlers = new Set<(message: WorkflowToolRunAgentStarted) => void>();
  const inbox: SessionInbox = {
    claimedTokens: [],
    claimSessionHook: vi.fn(),
    claimSessionHooks: vi.fn(),
    drain: () => queue.splice(0),
    hasPending: () => queue.length > 0,
    whenPending: () => new Promise<void>(() => {}),
    next: vi.fn(),
    restore: vi.fn(),
    onDelivery: () => () => {},
    onAgentStarted: (handler) => {
      agentStartedHandlers.add(handler);
      for (const payload of queue) if (payload.kind === "agent-started") handler(payload);
      return () => agentStartedHandlers.delete(handler);
    },
    onInterrupt: () => () => {},
  };
  return {
    inbox,
    /** The pump accepts a message and tells its observers. */
    arrive(message: WorkflowToolRunAgentStarted) {
      queue.push(message);
      for (const handler of agentStartedHandlers) handler(message);
    },
    /** The pump accepts a message no observer is subscribed for. */
    enqueue(message: WorkflowToolRunAgentStarted) {
      queue.push(message);
    },
  };
}

async function createSession(hook?: ReturnType<typeof defineHook>) {
  const runtime = await createTestRuntime({
    agent: { name: "step-agent-starts" },
    modules:
      hook === undefined
        ? []
        : [{ logicalPath: "hooks/audit.ts", loadNamespace: async () => ({ default: hook }) }],
  });
  const streamed: MessageStreamEvent[] = [];
  const sessionState = createTestSessionState({
    emissionState: { sequence: 0, sessionStarted: true, stepIndex: 0, turnId: "turn_0" },
  });
  const inbox = createInbox();
  const cursor = new SessionStateCursor({
    inbox: inbox.inbox,
    serializedContext: {
      "eve.auth": null,
      "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
      "eve.channel": { kind: "http", state: {} },
      "eve.continuationToken": "test-token",
      "eve.sessionId": sessionState.sessionId,
    },
    sessionState,
    sessionWritable: new WritableStream<Uint8Array>({
      write(chunk) {
        streamed.push(JSON.parse(new TextDecoder().decode(chunk)) as MessageStreamEvent);
      },
    }),
  });
  const execution = new SessionExecution({
    cursor,
    inbox: inbox.inbox,
    queue: new SessionInputQueue(),
    sessionId: sessionState.sessionId,
  });
  return {
    agentStartedIds: () =>
      streamed.flatMap((event) => (event.type === "agent.started" ? [event.data.sessionId] : [])),
    cursor,
    streamed,
    /**
     * Runs one turn whose single model step runs `duringStep`. The step's
     * result writes the step marker; a function `duringStep` returns runs as
     * the step ends.
     */
    async runTurn(
      duringStep: (pump: ReturnType<typeof createInbox>) => Promise<(() => void) | void>,
    ) {
      vi.mocked(turnStep).mockImplementationOnce(async (step) => {
        const atEnd = await duringStep(inbox);
        atEnd?.();
        return {
          action: "done",
          serializedContext: { ...step.serializedContext, [STEP_MARKER]: "after the step" },
          sessionState: step.sessionState,
        };
      });
      await runtime.run(async () => await execution.runTurn(undefined));
    },
  };
}
