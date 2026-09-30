import { describe, expect, it } from "vitest";

import {
  createActionsRequestedEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
  createSessionWaitingEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
  createTurnWaitingEvent,
  type InputResolutionOutcome,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import {
  callStatus,
  initialSessionProjection,
  reduceSessionProjection,
  type SessionProjection,
} from "#protocol/session-projection.js";

function fold(
  events: readonly UnstampedMessageStreamEvent[],
  state: SessionProjection = initialSessionProjection(),
): SessionProjection {
  return events.reduce(reduceSessionProjection, state);
}

const action = { callId: "deploy", input: {}, kind: "tool-call" as const, toolName: "deploy" };

/** Alice's turn asks Bob to approve a deploy. */
function askToDeploy(turnId: string): readonly UnstampedMessageStreamEvent[] {
  return [
    createTurnStartedEvent({ sequence: 0, turnId }),
    createActionsRequestedEvent({ actions: [action], sequence: 0, stepIndex: 0, turnId }),
    createInputRequestedEvent({
      requests: [{ action, kind: "tool-approval", prompt: "Deploy?", requestId: "approve" }],
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
  ];
}

function answer(outcome: InputResolutionOutcome): UnstampedMessageStreamEvent {
  return createInputResolvedEvent({
    resolutions: [{ kind: "tool-approval", outcome, requestId: "approve" }],
    sequence: 0,
    stepIndex: 0,
    turnId: "turn_1",
  });
}

describe("reduceSessionProjection", () => {
  it("runs an approval answered while its turn is still open in that turn", () => {
    const state = fold([
      ...askToDeploy("turn_1"),
      createTurnWaitingEvent({ sequence: 0, turnId: "turn_1" }),
      answer("approved"),
    ]);

    expect(state.inputs.approve?.resumeTurnId).toBe("turn_1");
    expect(callStatus(state, "deploy")).toBe("running");
  });

  it("rejects a denied call before its result arrives, and resumes the turn that asked", () => {
    const asked = fold([
      ...askToDeploy("turn_1"),
      createTurnCompletedEvent({ sequence: 0, turnId: "turn_1" }),
    ]);
    expect(callStatus(asked, "deploy")).toBe("awaiting-input");

    const denied = fold(
      [answer("denied"), createTurnStartedEvent({ sequence: 1, turnId: "turn_2" })],
      asked,
    );
    expect(callStatus(denied, "deploy")).toBe("rejected");
    expect(denied.turns.turn_2?.rootTurnId).toBe("turn_1");
  });

  it("resumes nothing across a session boundary", () => {
    const state = fold([
      ...askToDeploy("turn_1"),
      createTurnCompletedEvent({ sequence: 0, turnId: "turn_1" }),
      answer("approved"),
      createSessionWaitingEvent(),
      createTurnStartedEvent({ sequence: 1, turnId: "turn_2" }),
    ]);

    expect(state.turns.turn_2?.rootTurnId).toBe("turn_2");
  });

  it("keeps an approved call waiting on the sign-in its turn ended on", () => {
    const state = fold([
      ...askToDeploy("turn_1"),
      createTurnCompletedEvent({ sequence: 0, turnId: "turn_1" }),
      answer("approved"),
      createTurnStartedEvent({ sequence: 1, turnId: "turn_2" }),
      createAuthorizationRequiredEvent({
        description: "Connect GitHub",
        name: "github",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_2",
      }),
      createTurnCompletedEvent({ sequence: 1, turnId: "turn_2" }),
    ]);

    expect(callStatus(state, "deploy")).toBe("awaiting-input");
  });

  it("completes the latest sign-in for a connection when the completion names no attempt", () => {
    const required = (turnId: string) =>
      createAuthorizationRequiredEvent({
        description: "Connect GitHub",
        name: "github",
        sequence: 0,
        stepIndex: 0,
        turnId,
        webhookUrl: "https://agent.example.com/callback",
      });
    const state = fold([
      required("turn_1"),
      required("turn_2"),
      createAuthorizationCompletedEvent({
        name: "github",
        outcome: "authorized",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_2",
      }),
    ]);

    expect(
      Object.values(state.authorizations).map(({ status, turnId }) => ({ status, turnId })),
    ).toEqual([
      { status: "required", turnId: "turn_1" },
      { status: "completed", turnId: "turn_2" },
    ]);
  });
});
