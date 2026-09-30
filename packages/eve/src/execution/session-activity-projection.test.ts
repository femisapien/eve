import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { ActivityObserverKey } from "#context/keys.js";
import { deriveRootTurnActivityWorkId } from "#execution/activity-work-id.js";
import {
  advanceSessionActivity,
  observeSessionActivity,
} from "#execution/session-activity-projection.js";
import { createActivitySnapshot, reduceActivityBatch } from "#execution/session-activity.js";
import { captureLogRecords } from "#internal/testing/log-records.js";
import { stampTestEvent } from "#internal/testing/events.js";
import type {
  ActivityEventV1,
  ActivitySnapshotV1,
  ActivityWorkIdentityV1,
} from "#protocol/activity.js";
import {
  createActionPartialEvent,
  createActionResultEvent,
  createActionsRequestedEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
  createSessionStartedEvent,
  createSessionWaitingEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import { initialSessionProjection } from "#protocol/session-projection.js";

const sessionId = "session-1";
const rootWork = (turnId: string) => deriveRootTurnActivityWorkId({ sessionId, turnId });

/** Runs events through the session's activity exactly as `observeSessionActivity` does. */
function fold(
  events: readonly UnstampedMessageStreamEvent[],
  workIdentity?: ActivityWorkIdentityV1,
): { readonly emitted: readonly ActivityEventV1[]; readonly snapshot: ActivitySnapshotV1 } {
  let projection = initialSessionProjection();
  let snapshot = createActivitySnapshot();
  const emitted: ActivityEventV1[] = [];
  events.forEach((event, index) => {
    const advanced = advanceSessionActivity({
      event: stampTestEvent(event, index),
      previous: projection,
      sessionId,
      workIdentity,
    });
    projection = advanced.projection;
    emitted.push(...advanced.events);
    snapshot = reduceActivityBatch(snapshot, { events: advanced.events, version: 1 });
  });
  return { emitted, snapshot };
}

function lookup(callId: string, turnId: string, stepIndex = 0): UnstampedMessageStreamEvent {
  return createActionsRequestedEvent({
    actions: [{ callId, input: {}, kind: "tool-call", toolName: "lookup" }],
    sequence: 0,
    stepIndex,
    turnId,
  });
}

function result(callId: string, turnId: string): UnstampedMessageStreamEvent {
  return createActionResultEvent({
    result: { callId, kind: "tool-result", output: "Found", toolName: "lookup" },
    sequence: 0,
    stepIndex: 0,
    turnId,
  });
}

const start = (turnId: string) => createTurnStartedEvent({ sequence: 0, turnId });
const complete = (turnId: string) => createTurnCompletedEvent({ sequence: 0, turnId });

/** Alice's turn asks to approve a lookup, which ends it. */
const askedForApproval: readonly UnstampedMessageStreamEvent[] = [
  start("turn-1"),
  lookup("lookup-1", "turn-1"),
  createInputRequestedEvent({
    requests: [
      {
        action: { callId: "lookup-1", input: {}, kind: "tool-call", toolName: "lookup" },
        kind: "tool-approval",
        prompt: "Approve the lookup?",
        requestId: "approve-1",
      },
    ],
    sequence: 0,
    stepIndex: 0,
    turnId: "turn-1",
  }),
  complete("turn-1"),
];

describe("advanceSessionActivity", () => {
  it("starts and settles a root turn's work and calls", () => {
    const { snapshot } = fold([
      start("turn-1"),
      lookup("lookup-1", "turn-1"),
      result("lookup-1", "turn-1"),
      complete("turn-1"),
    ]);

    expect(snapshot.work[rootWork("turn-1")]).toMatchObject({ phase: "completed" });
    expect(snapshot.actions[`action:${rootWork("turn-1")}:lookup-1`]).toMatchObject({
      phase: "completed",
    });
  });

  it("keeps a turn's work open on its approval, and groups the turn that runs it", () => {
    const parked = fold(askedForApproval);
    expect(parked.snapshot.work[rootWork("turn-1")]).toMatchObject({ phase: "running" });

    const { emitted, snapshot } = fold([
      ...askedForApproval,
      createInputResolvedEvent({
        resolutions: [{ kind: "tool-approval", outcome: "approved", requestId: "approve-1" }],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      }),
      start("turn-2"),
      result("lookup-1", "turn-2"),
      complete("turn-2"),
    ]);

    expect(
      emitted.some((event) => event.kind === "work.started" && event.work.turnId === "turn-2"),
    ).toBe(true);
    expect(Object.keys(snapshot.work)).toEqual([rootWork("turn-1")]);
    expect(snapshot.work[rootWork("turn-1")]).toMatchObject({ phase: "completed" });
    expect(snapshot.actions[`action:${rootWork("turn-1")}:lookup-1`]).toMatchObject({
      phase: "completed",
    });
  });

  it("starts fresh work for a message that arrives while an approval waits", () => {
    const { snapshot } = fold([...askedForApproval, start("turn-2"), complete("turn-2")]);

    expect(snapshot.work[rootWork("turn-1")]).toMatchObject({ phase: "running" });
    expect(snapshot.work[rootWork("turn-2")]).toMatchObject({ phase: "completed" });
  });

  it("groups the turn a sign-in callback resumes with the turn that asked", () => {
    const { snapshot } = fold([
      start("turn-1"),
      createAuthorizationRequiredEvent({
        attemptId: "attempt-1",
        description: "Connect GitHub",
        name: "github",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
        webhookUrl: "https://agent.example.com/callback",
      }),
      complete("turn-1"),
      createAuthorizationCompletedEvent({
        attemptId: "attempt-1",
        name: "github",
        outcome: "authorized",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      start("turn-2"),
      complete("turn-2"),
    ]);

    expect(Object.keys(snapshot.work)).toEqual([rootWork("turn-1")]);
    expect(snapshot.work[rootWork("turn-1")]).toMatchObject({ phase: "completed" });
    expect(snapshot.blockers[`authorization:${rootWork("turn-1")}:attempt-1`]).toMatchObject({
      phase: "completed",
    });
  });

  it("keeps a task call running from its receipt until task.settled", () => {
    const actionId = `action:${rootWork("turn-1")}:report-1`;
    const started = [
      start("turn-1"),
      lookup("report-1", "turn-1"),
      createTaskStartedEvent({
        callId: "report-1",
        kind: "tool",
        name: "report",
        taskId: "task-1",
        turnId: "turn-1",
      }),
      result("report-1", "turn-1"),
    ];
    expect(fold(started).snapshot.actions[actionId]).toMatchObject({ phase: "running" });

    const settled = fold([
      ...started,
      createTaskSettledEvent({
        callId: "report-1",
        error: { message: "Source unavailable." },
        status: "failed",
        taskId: "task-1",
        turnId: "turn-1",
      }),
    ]);
    expect(settled.snapshot.actions[actionId]).toMatchObject({ phase: "failed" });
  });

  it("interrupts a call its failed turn cut off", () => {
    const { snapshot } = fold([
      start("turn-1"),
      lookup("lookup-1", "turn-1"),
      createTurnFailedEvent({
        code: "MODEL_ERROR",
        message: "Model failed.",
        sequence: 0,
        turnId: "turn-1",
      }),
    ]);

    expect(snapshot.actions[`action:${rootWork("turn-1")}:lookup-1`]).toMatchObject({
      phase: "interrupted",
    });
    expect(snapshot.work[rootWork("turn-1")]).toMatchObject({ phase: "failed" });
  });

  it("uses the durable partial event id for activity updates", () => {
    const { emitted } = fold([
      start("turn-1"),
      lookup("tool-1", "turn-1"),
      createActionPartialEvent({
        presentation: { "tool-1": { label: "Collecting sources" } },
        result: { callId: "tool-1", kind: "tool-result", output: {}, toolName: "lookup" },
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      }),
    ]);

    expect(emitted).toContainEqual(
      expect.objectContaining({
        eventId: expect.stringContaining(":update:evt_test_0002"),
        kind: "action.label.updated",
        label: "Collecting sources",
      }),
    );
  });

  it("maps a delegated session's start and keeps its question open while parked", () => {
    const workIdentity: ActivityWorkIdentityV1 = {
      callId: "call-1",
      id: "work:parent:turn-1:call-1",
      kind: "subagent",
      name: "researcher",
      parentId: "root:parent:turn-1",
      rootSessionId: "parent",
      rootTurnId: "turn-1",
    };
    const { snapshot } = fold(
      [
        createSessionStartedEvent(),
        createInputRequestedEvent({
          requests: [
            {
              action: { callId: "tool-1", input: {}, kind: "tool-call", toolName: "search" },
              kind: "question",
              prompt: "Which region?",
              requestId: "request-1",
            },
          ],
          sequence: 1,
          stepIndex: 0,
          turnId: "child-turn",
        }),
        complete("child-turn"),
        createSessionWaitingEvent("child-token"),
      ],
      workIdentity,
    );

    expect(snapshot.work[workIdentity.id]).toMatchObject({ phase: "running" });
    expect(snapshot.blockers[`input:${workIdentity.id}:request-1`]).toMatchObject({
      phase: "blocked",
    });
  });
});

describe("observeSessionActivity", () => {
  afterEach(() => vi.unstubAllGlobals());

  function context(): ContextContainer {
    const ctx = new ContextContainer();
    ctx.set(ActivityObserverKey, {
      sink: {
        url: "https://agent.example.com/eve/v1/activity/abcdefghijklmnopqrstuvwxyz123456",
        version: 1,
      },
    });
    return ctx;
  }

  it("does not submit events with no activity projection", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await observeSessionActivity({
      ctx: context(),
      event: stampTestEvent({
        data: { messageDelta: "hello", sequence: 0, stepIndex: 0, turnId: "turn-1" },
        type: "message.appended",
      }),
      sessionId,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits projected activity and swallows transport failure", async () => {
    const logs = captureLogRecords();
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      observeSessionActivity({ ctx: context(), event: stampTestEvent(start("turn-1")), sessionId }),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(logs.records).toContainEqual(
      expect.objectContaining({ level: "warn", message: "activity sink request failed" }),
    );
  });
});
