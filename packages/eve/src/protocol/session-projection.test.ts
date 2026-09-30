import { describe, expect, it } from "vitest";

import {
  createActionResultEvent,
  createActionsRequestedEvent,
  createApprovalSettledEvent,
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
  createTaskStartedEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
  createTurnWaitingEvent,
  type InputResolution,
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

function answer(
  resolution: Pick<InputResolution, "outcome" | "resumeTurnId">,
): UnstampedMessageStreamEvent {
  return createInputResolvedEvent({
    resolutions: [{ ...resolution, kind: "tool-approval", requestId: "approve" }],
    sequence: 0,
    stepIndex: 0,
    turnId: "turn_1",
  });
}

describe("reduceSessionProjection", () => {
  it("runs an approved call in the turn its approval names, until that turn ends", () => {
    const asked = fold([
      ...askToDeploy("turn_1"),
      createTurnCompletedEvent({ sequence: 0, turnId: "turn_1" }),
    ]);
    expect(callStatus(asked, "deploy")).toBe("awaiting-input");

    const approved = fold([answer({ outcome: "approved", resumeTurnId: "turn_2" })], asked);
    expect(approved.inputs.approve?.resumeTurnId).toBe("turn_2");
    expect(callStatus(approved, "deploy")).toBe("running");

    const running = fold(
      [createTurnStartedEvent({ continuesTurnId: "turn_1", sequence: 1, turnId: "turn_2" })],
      approved,
    );
    expect(callStatus(running, "deploy")).toBe("running");
    expect(
      callStatus(
        fold([createTurnCompletedEvent({ sequence: 1, turnId: "turn_2" })], running),
        "deploy",
      ),
    ).toBe("interrupted");
  });

  it("keeps the turn a batch names for an approval a policy settled first", () => {
    const state = fold([
      ...askToDeploy("turn_1"),
      createTurnCompletedEvent({ sequence: 0, turnId: "turn_1" }),
      createApprovalSettledEvent({
        outcome: "approved",
        requestId: "approve",
        responderPrincipalId: "bob",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      answer({ outcome: "approved", resumeTurnId: "turn_2" }),
    ]);

    expect(state.inputs.approve?.resumeTurnId).toBe("turn_2");
    expect(callStatus(state, "deploy")).toBe("running");
  });

  it("groups a turn under the root of the turn it says it continues", () => {
    const state = fold([
      ...askToDeploy("turn_1"),
      createTurnCompletedEvent({ sequence: 0, turnId: "turn_1" }),
      answer({ outcome: "denied" }),
      createTurnStartedEvent({ continuesTurnId: "turn_1", sequence: 1, turnId: "turn_2" }),
      createTurnCompletedEvent({ sequence: 1, turnId: "turn_2" }),
      createTurnStartedEvent({ continuesTurnId: "turn_2", sequence: 2, turnId: "turn_3" }),
      createTurnCompletedEvent({ sequence: 2, turnId: "turn_3" }),
      createTurnStartedEvent({ sequence: 3, turnId: "turn_4" }),
    ]);

    expect(callStatus(state, "deploy")).toBe("rejected");
    expect(state.turns.turn_3?.rootTurnId).toBe("turn_1");
    expect(state.turns.turn_4?.rootTurnId).toBe("turn_4");
  });

  it("settles a call that asked for a sign-in as cancelled and ties the sign-in to it", () => {
    const state = fold([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
      createActionsRequestedEvent({
        actions: [action],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createActionResultEvent({
        cancelled: { code: "AUTHORIZATION_REQUIRED", message: "The call needs a sign-in." },
        result: {
          callId: "deploy",
          isError: true,
          kind: "tool-result",
          output: null,
          toolName: "deploy",
        },
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createAuthorizationRequiredEvent({
        attemptId: "attempt_github",
        callIds: ["deploy"],
        description: "Connect GitHub",
        name: "github",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createTurnCompletedEvent({ sequence: 0, turnId: "turn_1" }),
    ]);

    expect(callStatus(state, "deploy")).toBe("cancelled");
    expect(state.authorizations.attempt_github?.callIds).toEqual(["deploy"]);
  });

  it("holds a task's call on the request its run passes up, without adopting the subagent's call", () => {
    const research = {
      callId: "research",
      input: {},
      kind: "tool-call" as const,
      toolName: "researcher",
    };
    const subagentCall = { ...action, callId: "subagent_deploy" };
    const asked = fold([
      createTurnStartedEvent({ sequence: 0, turnId: "turn_1" }),
      createActionsRequestedEvent({
        actions: [research],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
      createTaskStartedEvent({
        callId: "research",
        kind: "agent",
        name: "researcher",
        taskId: "task_1",
        turnId: "turn_1",
      }),
      createInputRequestedEvent({
        callId: "research",
        requests: [
          { action: subagentCall, kind: "tool-approval", prompt: "Deploy?", requestId: "passed" },
        ],
        sequence: 0,
        stepIndex: 0,
        taskId: "task_1",
        turnId: "turn_1",
      }),
    ]);

    expect(asked.inputs.passed?.callId).toBe("research");
    expect(asked.calls.subagent_deploy).toBeUndefined();
    expect(callStatus(asked, "research")).toBe("awaiting-input");

    const answered = fold(
      [
        createInputResolvedEvent({
          resolutions: [{ kind: "tool-approval", outcome: "approved", requestId: "passed" }],
          sequence: 0,
          stepIndex: 0,
          turnId: "turn_1",
        }),
      ],
      asked,
    );
    expect(callStatus(answered, "research")).toBe("running");
  });

  it("completes only the sign-in attempt a completion names", () => {
    const required = (attemptId: string, turnId: string) =>
      createAuthorizationRequiredEvent({
        attemptId,
        description: "Connect GitHub",
        name: "github",
        sequence: 0,
        stepIndex: 0,
        turnId,
        webhookUrl: "https://agent.example.com/callback",
      });
    const state = fold([
      required("attempt_alice", "turn_1"),
      createTurnWaitingEvent({ sequence: 0, turnId: "turn_1" }),
      required("attempt_bob", "turn_2"),
      createAuthorizationCompletedEvent({
        attemptId: "attempt_alice",
        name: "github",
        outcome: "authorized",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn_1",
      }),
    ]);

    expect(state.authorizations.attempt_alice?.status).toBe("completed");
    expect(state.authorizations.attempt_bob?.status).toBe("required");
  });
});
