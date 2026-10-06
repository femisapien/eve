import { describe, expect, it } from "vitest";

import {
  answer,
  BUDGET_QUESTION,
  overBudget,
  approval,
  Turn,
  waitingOnApprovals,
  waitingOnBudget,
} from "#internal/testing/hitl.js";
import type { RelayRoute, RequestAt } from "#harness/hitl/index.js";

const CHILD_AT: RequestAt = { sequence: 4, stepIndex: 2, turnId: "child_turn_0" };
const CHILD: RelayRoute = { childContinuationToken: "child-token", runId: "run-child" };

describe("HumanInput.isWaitingForInput", () => {
  it("is false with nothing open", () => {
    expect(Turn.idle().humanInput.isWaitingForInput()).toBe(false);
  });

  it("is true while one of the turn's own requests is open", () => {
    expect(waitingOnApprovals("deploy").humanInput.isWaitingForInput()).toBe(true);
    expect(waitingOnBudget().humanInput.isWaitingForInput()).toBe(true);
  });

  it("is false once approved calls are ready, though another request is still unanswered", () => {
    const turn = waitingOnApprovals("deploy")
      .input(answer("approve", "deploy"))
      .input(overBudget());
    expect(turn.humanInput.openRequestIds()).toEqual(new Set([BUDGET_QUESTION.requestId]));
    expect(turn.humanInput.next()).toEqual({ run: "approved" });
    expect(turn.humanInput.isWaitingForInput()).toBe(false);
  });

  it("is false for a relayed request alone, which waits on the call that asked", () => {
    const turn = Turn.idle().input({
      at: CHILD_AT,
      requests: [approval("child")],
      route: CHILD,
      type: "relayed.requested",
    });
    expect(turn.humanInput.relayedRequestIds()).toEqual(new Set(["child"]));
    expect(turn.humanInput.isWaitingForInput()).toBe(false);
  });
});
