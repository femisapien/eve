import { describe, expect, it } from "vitest";

import { getPendingAuthorization, setPendingAuthorization } from "#harness/authorization.js";
import { intake, textAnswerable } from "#harness/hitl/machine.js";
import { openApprovalRequestIds } from "#harness/open-approvals.js";
import { readTurnInputRequests, upsertRelayedInputRequests } from "#harness/open-input-requests.js";
import { openSessionLimitRequest } from "#harness/session-limit-request.js";
import { readTurnState } from "#harness/turn-state.js";
import type { HarnessSession } from "#harness/types.js";
import { parkApprovals } from "#internal/testing/approval-fixtures.js";
import type { InputRequest } from "#shared/input.js";

const AT = { sequence: 3, stepIndex: 2, turnId: "turn_1" };
const ASKED = { sequence: 1, stepIndex: 0, turnId: "turn_1" };

const APPROVAL: InputRequest = {
  action: { callId: "call-1", input: { to: "bob" }, kind: "tool-call", toolName: "send_email" },
  allowFreeform: false,
  display: "confirmation",
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  prompt: "Send the report to Bob?",
  requestId: "approval-1",
};

const BUDGET: InputRequest = {
  action: { callId: "limit", input: {}, kind: "tool-call", toolName: "session-limit" },
  kind: "session-limit",
  options: [
    { id: "continue", label: "Continue" },
    { id: "stop", label: "Stop" },
  ],
  prompt: "Alice's session is over budget. Continue?",
  requestId: "limit-1",
};

/** Alice's held turn: an approval, the budget question, and a sign-in to Linear. */
function heldTurn(): HarnessSession {
  const session = openSessionLimitRequest(
    parkApprovals({
      event: ASKED,
      requests: [APPROVAL],
      responseMessages: [
        {
          content: [
            {
              input: { to: "bob" },
              toolCallId: "call-1",
              toolName: "send_email",
              type: "tool-call",
            },
          ],
          role: "assistant",
        },
      ],
      session: {
        agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "alice",
        history: [{ content: "Email the report to Bob.", kind: "user", role: "user" }],
        sessionId: "alice-session",
      },
    }),
    { ...ASKED, request: BUDGET },
  );
  return {
    ...session,
    state: setPendingAuthorization(session.state, {
      challenges: [
        {
          attemptId: "attempt-1",
          challenge: { url: "https://idp.example/linear" },
          hookUrl: "https://eve.example/linear",
          name: "linear",
        },
      ],
    }),
  };
}

describe("intake: cancel", () => {
  it("ends every request the turn holds and gives the waiting call a not-run result", () => {
    const cancelled = intake(heldTurn().state, { at: AT, kind: "cancel" });

    expect(readTurnInputRequests(cancelled.state).size).toBe(0);
    expect(readTurnState(cancelled.state).suspended[0]).toBeUndefined();
    expect(getPendingAuthorization(cancelled.state)).toBeUndefined();
    expect(cancelled.effects).toEqual([
      {
        event: expect.objectContaining({
          data: expect.objectContaining({
            name: "linear",
            outcome: "declined",
            reason: "Cancelled.",
          }),
          type: "authorization.completed",
        }),
        kind: "event",
      },
      {
        event: expect.objectContaining({
          data: expect.objectContaining({
            resolutions: [{ kind: "tool-approval", outcome: "cancelled", requestId: "approval-1" }],
            ...ASKED,
          }),
          type: "input.resolved",
        }),
        kind: "event",
      },
      {
        event: expect.objectContaining({
          data: expect.objectContaining({
            resolutions: [{ kind: "session-limit", outcome: "cancelled", requestId: "limit-1" }],
          }),
          type: "input.resolved",
        }),
        kind: "event",
      },
      // The withheld response joins history with the waiting call answered.
      {
        kind: "history",
        message: expect.objectContaining({
          content: [expect.objectContaining({ toolCallId: "call-1", type: "tool-call" })],
          role: "assistant",
        }),
      },
      {
        kind: "history",
        message: {
          content: [
            {
              output: { reason: "Cancelled before anyone answered.", type: "execution-denied" },
              toolCallId: "call-1",
              toolName: "send_email",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      },
    ]);
  });
});

describe("intake: steer", () => {
  it("ends the turn's sign-ins and tells the model, leaving the approval and budget question open", () => {
    const steered = intake(heldTurn().state, { at: AT, kind: "steer" });

    expect(openApprovalRequestIds(steered.state)).toEqual(new Set(["approval-1"]));
    expect([...readTurnInputRequests(steered.state).keys()]).toEqual(["limit-1"]);
    expect(getPendingAuthorization(steered.state)).toBeUndefined();
    expect(steered.effects).toEqual([
      {
        event: expect.objectContaining({
          data: expect.objectContaining({
            name: "linear",
            outcome: "declined",
            reason: "Cancelled because a new message arrived.",
            ...AT,
          }),
          type: "authorization.completed",
        }),
        kind: "event",
      },
      { kind: "note", text: expect.stringContaining("Sign-in to linear was cancelled") },
    ]);
  });

  it("changes nothing when the turn holds no sign-in", () => {
    const session = heldTurn();
    const state = { ...session.state };
    delete state["eve.runtime.pendingAuthorization"];

    const steered = intake(state, { at: AT, kind: "steer" });

    expect(steered).toEqual({ effects: [], state });
  });
});

describe("textAnswerable", () => {
  function approvalsOnly(...requests: InputRequest[]): HarnessSession {
    return parkApprovals({
      event: ASKED,
      requests,
      session: { ...heldTurn(), history: [], state: undefined },
    });
  }
  const second: InputRequest = {
    ...APPROVAL,
    action: { ...APPROVAL.action, callId: "call-2" },
    requestId: "approval-2",
  };

  it("answers one step's approvals together", () => {
    expect(textAnswerable(approvalsOnly(APPROVAL, second).state)).toEqual({
      kind: "approvals",
      requests: [APPROVAL, second],
    });
  });

  it("answers nothing when an approval needs a responder's sign-in", () => {
    const session = parkApprovals({
      event: ASKED,
      requests: [APPROVAL, second],
      responseAuthRequiredRequestIds: ["approval-2"],
      session: { ...heldTurn(), history: [], state: undefined },
    });
    expect(textAnswerable(session.state)).toBeUndefined();
  });

  it("answers nothing when the budget question is open beside an approval", () => {
    expect(textAnswerable(heldTurn().state)).toBeUndefined();
  });

  it("answers nothing when a relayed question is open beside the turn's approval", () => {
    const session = upsertRelayedInputRequests({
      entries: [
        [
          "ask-1",
          {
            childContinuationToken: "child",
            event: ASKED,
            kind: "question",
            question: { options: [{ id: "approve", label: "Approve" }] },
          },
        ],
      ],
      forChildContinuationToken: "child",
      session: approvalsOnly(APPROVAL),
    });
    expect(textAnswerable(session.state)).toBeUndefined();
  });
});
