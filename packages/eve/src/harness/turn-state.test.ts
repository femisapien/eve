import { describe, expect, it } from "vitest";

import {
  readTurnState,
  settleCall,
  takeSettledSteps,
  type TurnState,
} from "#harness/turn-state.js";

const origin = { sequence: 0, stepIndex: 0, turnId: "turn_0" };

function turnStateWithStep(): TurnState {
  return {
    ...readTurnState(undefined),
    steps: [
      {
        calls: [
          { callId: "review", input: {}, status: "running", toolName: "review" },
          { callId: "deploy", input: {}, status: "running", toolName: "deploy" },
        ],
        origin,
        response: [
          {
            content: [
              { input: {}, toolCallId: "lint", toolName: "lint", type: "tool-call" },
              { input: {}, toolCallId: "review", toolName: "review", type: "tool-call" },
              { input: {}, toolCallId: "deploy", toolName: "deploy", type: "tool-call" },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { type: "text", value: "clean" },
                toolCallId: "lint",
                toolName: "lint",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
        ],
      },
    ],
  };
}

function result(toolCallId: string) {
  return {
    output: { type: "text" as const, value: `${toolCallId} done` },
    toolCallId,
    toolName: toolCallId,
    type: "tool-result" as const,
  };
}

describe("takeSettledSteps", () => {
  it("commits a step once, when its last call settles, joining its results to its tool message", () => {
    const partial = settleCall(turnStateWithStep(), "review", result("review"));
    expect(takeSettledSteps(partial).messages).toEqual([]);

    const settled = takeSettledSteps(settleCall(partial, "deploy", result("deploy")));

    expect(settled.turnState.steps).toEqual([]);
    expect(settled.messages).toHaveLength(2);
    expect(settled.messages[1]).toMatchObject({
      content: [{ toolCallId: "lint" }, { toolCallId: "review" }, { toolCallId: "deploy" }],
      role: "tool",
    });
  });
});

describe("readTurnState", () => {
  it("rejects state written by another turn state version", () => {
    expect(() => readTurnState({ "eve.session": { steps: [], version: 0 } })).toThrow(
      "Unsupported session state: start a new session.",
    );
  });
});
