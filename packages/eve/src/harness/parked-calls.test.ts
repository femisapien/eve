import { describe, expect, it } from "vitest";

import { resolveApprovalText } from "#harness/parked-calls.js";
import { readTurnState } from "#harness/turn-state.js";
import type { HarnessSession } from "#harness/types.js";
import { parkApprovalStep } from "#internal/testing/turn-state.js";
import type { InputRequest } from "#shared/input.js";

function approvalRequest(requestId: string): InputRequest {
  return {
    action: { callId: `${requestId}-call`, input: {}, kind: "tool-call", toolName: "deploy" },
    allowFreeform: false,
    display: "confirmation",
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: "Approve tool call: deploy",
    requestId,
  };
}

function park(session: HarnessSession, requestId: string, responsePolicy?: true): HarnessSession {
  return parkApprovalStep(session, {
    requests: [approvalRequest(requestId)],
    response: [],
    responsePolicy,
  });
}

const empty = {} as HarnessSession;

describe("resolveApprovalText", () => {
  it.each(["approve", "APPROVE", "1"])(
    "answers the one open step's approval with %s",
    (message) => {
      const turnState = readTurnState(park(empty, "approval-1").state);

      expect(resolveApprovalText(turnState, { message })).toEqual({
        inputResponses: [{ optionId: "approve", requestId: "approval-1" }],
      });
    },
  );

  it("leaves text as a message while two steps await approval", () => {
    const turnState = readTurnState(park(park(empty, "approval-1"), "approval-2").state);

    expect(resolveApprovalText(turnState, { message: "approve" })).toEqual({ message: "approve" });
  });

  it("never answers with text an approval whose tool authorizes its responders", () => {
    const turnState = readTurnState(park(empty, "approval-1", true).state);

    expect(resolveApprovalText(turnState, { message: "approve" })).toEqual({ message: "approve" });
  });

  it("keeps an explicit response over approval text", () => {
    const turnState = readTurnState(park(empty, "approval-1").state);
    const input = {
      inputResponses: [{ optionId: "cancel", requestId: "approval-1" }],
      message: "approve",
    };

    expect(resolveApprovalText(turnState, input)).toEqual(input);
  });
});
