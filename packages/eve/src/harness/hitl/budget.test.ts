import { describe, expect, it } from "vitest";

import {
  AT,
  BUDGET_QUESTION,
  answer,
  answered,
  cancel,
  waitingOnBudget,
  message,
  overBudget,
} from "#internal/testing/hitl.js";

const { requestId } = BUDGET_QUESTION;

describe("the budget question", () => {
  it("running over budget asks once per violation and the turn waits until it is answered", () => {
    const asked = waitingOnBudget();

    expect(asked.published("input.requested")).toEqual([
      { data: { ...AT, requests: [BUDGET_QUESTION] }, type: "input.requested" },
    ]);
    expect(asked.next()).toEqual({ waiting: "input" });

    const again = asked.stored().input(overBudget({ ...AT, stepIndex: 1 }));
    expect(again.events).toEqual([]);
    expect(again.next()).toEqual({ waiting: "input" });
  });

  it("Continue grants a fresh budget window and the turn runs again", () => {
    const turn = waitingOnBudget().input(answer("continue", requestId));

    expect(turn.reported("grantBudget")).toHaveLength(1);
    expect(turn.resolutions()).toEqual([
      {
        kind: "session-limit",
        outcome: "answered",
        requestId,
        response: { optionId: "continue", requestId },
      },
    ]);
    expect(turn.next()).toEqual({ run: "model" });
    expect(turn.storesNothing()).toBe(true);
  });

  it("Stop resolves the question and cancels the turn", () => {
    const turn = waitingOnBudget().input(answer("stop", requestId));

    expect(turn.reported("declineBudget")).toEqual([{ requestId, type: "declineBudget" }]);
    expect(turn.reported("grantBudget")).toEqual([]);
    expect(turn.storesNothing()).toBe(true);
  });

  it.each([
    { given: ["continue", "stop"], wins: "stop" },
    { given: ["stop", "continue"], wins: "continue" },
  ])("of answers $given, the last one wins", ({ given, wins }) => {
    const turn = waitingOnBudget().input(
      answered(given.map((optionId) => ({ optionId, requestId }))),
    );

    expect(turn.resolutions().map(({ response }) => response?.optionId)).toEqual([wins]);
    expect(turn.reported("grantBudget")).toHaveLength(wins === "continue" ? 1 : 0);
    expect(turn.reported("declineBudget")).toHaveLength(wins === "stop" ? 1 : 0);
  });

  it("a typed reply that names an option answers it, and the turn does not read the reply", () => {
    const turn = waitingOnBudget().input(message("approve"));

    expect(turn.events[0]).toEqual({ type: "consumeMessage" });
    expect(turn.reported("grantBudget")).toHaveLength(1);
  });

  it("a cancel withdraws the question unanswered", () => {
    const turn = waitingOnBudget().input(cancel);

    expect(turn.resolutions()).toEqual([
      { kind: "session-limit", outcome: "cancelled", requestId },
    ]);
    expect(turn.storesNothing()).toBe(true);
  });

  it("a step rolled back after publishing its answer closes the question silently, so a cancel doesn't withdraw it", () => {
    const rolledBack = waitingOnBudget().input({ resolved: [requestId], type: "step.rolledBack" });

    expect(rolledBack.events).toEqual([]);
    expect(rolledBack.storesNothing()).toBe(true);
    expect(rolledBack.stored().input(cancel).resolutions()).toEqual([]);
  });

  it("a rolled-back step that resolved something else leaves the question open", () => {
    const rolledBack = waitingOnBudget().input({ resolved: ["other"], type: "step.rolledBack" });

    expect(rolledBack.events).toEqual([]);
    expect(rolledBack.next()).toEqual({ waiting: "input" });
  });

  it.each([
    { input: message("Also check the invoices."), name: "a message that answers nothing" },
    { input: answer("maybe", requestId), name: "an answer with neither option" },
  ])("$name leaves the question open and the turn waiting", ({ input }) => {
    const turn = waitingOnBudget().input(input);

    expect(turn.events).toEqual([]);
    expect(turn.next()).toEqual({ waiting: "input" });
  });

  it("a late answer to a closed budget question is dropped, not read as a message", () => {
    const closed = waitingOnBudget().input(answer("continue", requestId)).stored();

    const accepted = closed.humanInput.acceptInput({
      inputResponses: [{ optionId: "stop", requestId }],
    });

    expect(accepted).toEqual({ input: {} });
  });
});
