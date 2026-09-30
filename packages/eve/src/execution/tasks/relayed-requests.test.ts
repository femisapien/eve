import { describe, expect, it, vi } from "vitest";

import { readDurableSession } from "#execution/durable-session-store.js";
import { applyTaskRunMessageStep, cancelTasksStep } from "#execution/tasks/steps.js";
import {
  createTask,
  markTaskRunStarted,
  readTaskTable,
  recordTaskRun,
  writeTaskTable,
} from "#execution/tasks/table.js";
import type { WorkflowToolRunRef } from "#execution/tools/workflow/messages.js";
import {
  getProxyInputRequests,
  upsertProxyInputRequestState,
  type ProxyInputRequest,
} from "#harness/proxy-input-requests.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { runSessionStateStep } from "#internal/testing/session-state-step.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

const published = vi.hoisted(
  (): { origin: "own" | "relayed"; event: UnstampedMessageStreamEvent }[] => [],
);

// Which events the steps publish, and in what order, is under test.
vi.mock("#execution/publish-session-events.js", () => {
  const publish =
    (origin: "own" | "relayed") =>
    async (
      target: { readonly serializedContext: unknown; readonly sessionState: unknown },
      events: readonly UnstampedMessageStreamEvent[],
    ) => {
      published.push(...events.map((event) => ({ event, origin })));
      return { serializedContext: target.serializedContext, sessionState: target.sessionState };
    };
  return { publishSessionEvents: publish("own"), relaySessionEvents: publish("relayed") };
});
vi.mock("#internal/workflow/runtime.js", () => ({ resumeHook: vi.fn(async () => {}) }));

/**
 * Alice's session runs Bob's research as a task. Its run relayed a question
 * from the research agent, at the coordinates of the call it serves; another
 * run relayed one of its own.
 */
function sessionWithRelayedQuestion() {
  const base = createTestSessionState({ sessionId: "alice-session" });
  const created = createTask(readTaskTable(undefined), {
    callId: "research-call",
    kind: "agent",
    name: "research",
    resumable: false,
    turnId: "turn_1",
  });
  const started = markTaskRunStarted(
    recordTaskRun(created.table, created.taskId, { hookToken: "run-1-control", runId: "run-1" }),
    created.taskId,
    "run-1",
  ).table;
  const route = (runId: string): ProxyInputRequest => ({
    childContinuationToken: `${runId}-child`,
    event: { sequence: 1, stepIndex: 0, turnId: "turn_1" },
    kind: "question",
    runId,
  });
  let state = upsertProxyInputRequestState({
    entries: [["research-question", route("run-1")]],
    forChildContinuationToken: "run-1-child",
    state: writeTaskTable(base.snapshot.session, started).state,
  });
  state = upsertProxyInputRequestState({
    entries: [["other-question", route("run-2")]],
    forChildContinuationToken: "run-2-child",
    state,
  });
  const from: WorkflowToolRunRef = {
    callId: "research-call",
    input: {},
    runId: "run-1",
    sequence: 1,
    stepIndex: 0,
    taskId: created.taskId,
    toolName: "research",
    turnId: "turn_1",
  };
  published.length = 0;
  return {
    from,
    input: {
      serializedContext: {},
      sessionState: { ...base, snapshot: { session: { ...base.snapshot.session, state } } },
      sessionWritable: new WritableStream<Uint8Array>(),
    },
    taskId: created.taskId,
  };
}

function remainingQuestions(sessionState: Parameters<typeof readDurableSession>[0]): string[] {
  return [...getProxyInputRequests(readDurableSession(sessionState).state).keys()];
}

describe("requests a task's run relayed", () => {
  it("resolve cancelled before a cancelled task settles, and stop routing to it", async () => {
    const { input, taskId } = sessionWithRelayedQuestion();

    const result = await runSessionStateStep({ ...input, taskIds: [taskId] }, cancelTasksStep);

    expect(published.map(({ event, origin }) => [origin, event.type])).toEqual([
      ["relayed", "input.resolved"],
      ["own", "task.settled"],
    ]);
    expect(published[0]!.event).toMatchObject({
      data: {
        resolutions: [{ kind: "question", outcome: "cancelled", requestId: "research-question" }],
        turnId: "turn_1",
      },
    });
    expect(remainingQuestions(result.sessionState)).toEqual(["other-question"]);
  });

  it("resolve cancelled before the task settles when its run finishes", async () => {
    const { from, input } = sessionWithRelayedQuestion();

    const result = await runSessionStateStep(
      {
        ...input,
        message: { from, kind: "outcome", result: { output: "Findings.", status: "completed" } },
      },
      applyTaskRunMessageStep,
    );

    expect(published.map(({ event }) => event.type)).toEqual(["input.resolved", "task.settled"]);
    expect(remainingQuestions(result.sessionState)).toEqual(["other-question"]);
  });
});
