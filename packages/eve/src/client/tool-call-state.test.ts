import { describe, expect, it } from "vitest";
import { conversationReducer, reduceConversation } from "#client/conversation-reducer.js";
import type { ConversationState } from "#client/conversation-state.js";
import type { EveDynamicToolPart } from "#client/message-reducer-types.js";
import { toolCallState, type ToolCallStatus } from "#client/tool-call-state.js";
import { stampTestEvent } from "#internal/testing/events.js";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  createApprovalSettledEvent,
  createInputRequestedEvent,
  createTurnCancelledEvent,
  createTurnCompletedEvent,
  createInputResolvedEvent,
  createTaskStartedEvent,
  createTurnStartedEvent,
  createTurnWaitingEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

let stamped = 0;

function reduce(
  events: readonly UnstampedMessageStreamEvent[],
  state: ConversationState = conversationReducer.initial(),
): ConversationState {
  return events.reduce(
    (current, event) => reduceConversation(current, stampTestEvent(event, stamped++)),
    state,
  );
}

const callIds = ["alice_lookup", "bob_lookup"];

/** Alice's turn asks to approve two lookups, which ends it. */
const askedForApproval = reduce([
  createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
  createActionsRequestedEvent({
    actions: callIds.map((callId) => ({
      callId,
      input: {},
      kind: "tool-call" as const,
      toolName: "lookup",
    })),
    sequence: 1,
    stepIndex: 0,
    turnId: "turn_1",
  }),
  createInputRequestedEvent({
    requests: callIds.map((callId) => ({
      action: { callId, input: {}, kind: "tool-call" as const, toolName: "lookup" },
      kind: "tool-approval" as const,
      prompt: "Approve the lookup?",
      requestId: `approve_${callId}`,
    })),
    sequence: 2,
    stepIndex: 0,
    turnId: "turn_1",
  }),
  createTurnCompletedEvent({ sequence: 3, turnId: "turn_1" }),
]);

function approve(callId: string): UnstampedMessageStreamEvent {
  return createApprovalSettledEvent({
    outcome: "approved",
    requestId: `approve_${callId}`,
    responderPrincipalId: "alice",
    sequence: 4,
    stepIndex: 0,
    turnId: "turn_1",
  });
}

/** The batch resolves once both lookups are decided; the approved calls run in `turn_2`. */
const batchResolved = createInputResolvedEvent({
  resolutions: callIds.map((callId) => ({
    kind: "tool-approval" as const,
    outcome: "approved" as const,
    requestId: `approve_${callId}`,
    resumeTurnId: "turn_2",
  })),
  sequence: 4,
  stepIndex: 0,
  turnId: "turn_1",
});

function statuses(state: ConversationState): Record<string, ToolCallStatus> {
  const entries = state.messages.flatMap((message) =>
    message.parts
      .filter((part): part is EveDynamicToolPart => part.type === "dynamic-tool")
      .map((part) => [part.toolCallId, toolCallState(state, part).status]),
  );
  return Object.fromEntries(entries);
}

describe("toolCallState", () => {
  it("runs an approved call in the turn its approval names, not the turn that asked", () => {
    expect(statuses(askedForApproval)).toEqual({
      alice_lookup: "awaiting-input",
      bob_lookup: "awaiting-input",
    });

    // Approved, but the batch still waits on Bob's lookup.
    const approvedOne = reduce([approve("alice_lookup")], askedForApproval);
    expect(statuses(approvedOne)).toEqual({
      alice_lookup: "awaiting-input",
      bob_lookup: "awaiting-input",
    });

    const resumed = reduce(
      [
        approve("bob_lookup"),
        batchResolved,
        createTurnStartedEvent({ continuesTurnId: "turn_1", sequence: 5, turnId: "turn_2" }),
        createActionResultEvent({
          result: { callId: "alice_lookup", kind: "tool-result", output: 7, toolName: "lookup" },
          sequence: 6,
          stepIndex: 0,
          turnId: "turn_2",
        }),
      ],
      approvedOne,
    );
    expect(statuses(resumed)).toEqual({ alice_lookup: "completed", bob_lookup: "running" });

    const ended = reduce([createTurnCompletedEvent({ sequence: 7, turnId: "turn_2" })], resumed);
    expect(statuses(ended)).toEqual({ alice_lookup: "completed", bob_lookup: "interrupted" });
  });

  it("cancels an approved call whose resumed turn was cancelled", () => {
    const state = reduce(
      [
        approve("alice_lookup"),
        approve("bob_lookup"),
        batchResolved,
        createTurnStartedEvent({ continuesTurnId: "turn_1", sequence: 5, turnId: "turn_2" }),
        createTurnCancelledEvent({ sequence: 6, turnId: "turn_2" }),
      ],
      askedForApproval,
    );
    expect(statuses(state)).toEqual({ alice_lookup: "cancelled", bob_lookup: "cancelled" });
  });

  it("keeps an answered question on the turn it parked, which resumes rather than ending", () => {
    const asked = reduce([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
      createActionsRequestedEvent({
        actions: [{ callId: "ask_bob", input: {}, kind: "tool-call", toolName: "ask_question" }],
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createInputRequestedEvent({
        requests: [
          {
            action: { callId: "ask_bob", input: {}, kind: "tool-call", toolName: "ask_question" },
            kind: "question",
            prompt: "Which report should Bob review?",
            requestId: "question_bob",
          },
        ],
        sequence: 2,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createTurnWaitingEvent({ sequence: 3, turnId: "turn_1" }),
      createInputResolvedEvent({
        resolutions: [
          {
            kind: "question",
            outcome: "answered",
            requestId: "question_bob",
            response: { requestId: "question_bob", text: "The quarterly one" },
          },
        ],
        sequence: 4,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);
    expect(statuses(asked)).toEqual({ ask_bob: "running" });

    const cancelled = reduce([createTurnCancelledEvent({ sequence: 5, turnId: "turn_1" })], asked);
    expect(cancelled.inputs.question_bob?.resumeTurnId).toBeUndefined();
    expect(statuses(cancelled)).toEqual({ ask_bob: "cancelled" });

    const next = reduce([createTurnStartedEvent({ sequence: 6, turnId: "turn_2" })], cancelled);
    expect(next.inputs.question_bob?.resumeTurnId).toBeUndefined();
    expect(statuses(next)).toEqual({ ask_bob: "cancelled" });
  });

  it("holds a task's call on the approval its subagent passed up, and shows the subagent's call through it", () => {
    const asked = reduce([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
      createActionsRequestedEvent({
        actions: [{ callId: "delegate", input: {}, kind: "tool-call", toolName: "researcher" }],
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createTaskStartedEvent({
        callId: "delegate",
        kind: "agent",
        name: "researcher",
        taskId: "task_1",
        turnId: "turn_1",
      }),
      createInputRequestedEvent({
        callId: "delegate",
        requests: [
          {
            action: { callId: "child_lookup", input: {}, kind: "tool-call", toolName: "lookup" },
            kind: "tool-approval",
            prompt: "Approve the researcher's lookup?",
            requestId: "approve_child_lookup",
          },
        ],
        sequence: 2,
        stepIndex: 0,
        taskId: "task_1",
        turnId: "turn_1",
      }),
      createTurnCompletedEvent({ sequence: 3, turnId: "turn_1" }),
    ]);
    expect(asked.inputs.approve_child_lookup?.callId).toBe("delegate");
    expect(statuses(asked)).toEqual({ child_lookup: "awaiting-input", delegate: "awaiting-input" });

    const approved = reduce(
      [
        createInputResolvedEvent({
          resolutions: [
            { kind: "tool-approval", outcome: "approved", requestId: "approve_child_lookup" },
          ],
          sequence: 4,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ],
      asked,
    );
    expect(statuses(approved)).toEqual({ child_lookup: "running", delegate: "running" });
  });
});
