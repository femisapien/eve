import { describe, expect, it } from "vitest";

import { HumanInput, type Intake } from "#harness/human-input/index.js";
import type { InputRequest } from "#shared/input.js";

const AT = { sequence: 1, stepIndex: 0, turnId: "turn_1" };

const BUDGET: InputRequest = {
  action: { callId: "s:limit:input:12", input: {}, kind: "tool-call", toolName: "session-limit" },
  kind: "session-limit",
  options: [
    { id: "continue", label: "Approve" },
    { id: "stop", label: "Stop" },
  ],
  prompt: "Alice's session is over budget. Continue?",
  requestId: "s:limit:input:12",
};

function asked(request: InputRequest = BUDGET): HumanInput {
  return HumanInput.read(undefined).interrupt({ at: AT, request, type: "budget.exceeded" })
    .humanInput;
}

function answer(optionId: string, requestId = BUDGET.requestId): Intake {
  return { responder: null, responses: [{ optionId, requestId }], type: "answered" };
}

function resolvedWith(outcome: string, response?: unknown) {
  return {
    event: {
      data: {
        ...AT,
        resolutions: [
          {
            kind: "session-limit",
            outcome,
            requestId: BUDGET.requestId,
            ...(response !== undefined && { response }),
          },
        ],
      },
      type: "input.resolved",
    },
    type: "publish",
  };
}

describe("HumanInput", () => {
  it("runs the model when nothing is open, and leaves no state behind", () => {
    const humanInput = HumanInput.read(undefined);

    expect(humanInput.next()).toEqual({ run: "model" });
    expect(humanInput.write({ other: 1 })).toEqual({ other: 1 });
  });

  it("fails a turn that needs a person until that case is rebuilt", () => {
    const { events, humanInput } = HumanInput.read(undefined).interrupt({
      at: AT,
      requests: [BUDGET],
      route: { childContinuationToken: "child" },
      type: "relayed.requested",
    });

    expect(events).toEqual([
      expect.objectContaining({ code: "HUMAN_INPUT_UNAVAILABLE", type: "turn.failed" }),
    ]);
    expect(humanInput.next()).toEqual({ run: "model" });
  });
});

describe("the budget question", () => {
  it("asks once per violation and holds the turn until it is answered", () => {
    const first = HumanInput.read(undefined).interrupt({
      at: AT,
      request: BUDGET,
      type: "budget.exceeded",
    });
    expect(first.events).toEqual([
      {
        event: { data: { ...AT, requests: [BUDGET] }, type: "input.requested" },
        type: "publish",
      },
    ]);
    expect(first.humanInput.next()).toEqual({ held: "input" });

    // The state survives the session store, as it would across steps.
    const stored = HumanInput.read(first.humanInput.write(undefined));
    const again = stored.interrupt({
      at: { ...AT, stepIndex: 1 },
      request: BUDGET,
      type: "budget.exceeded",
    });
    expect(again.events).toEqual([]);
    expect(again.humanInput.next()).toEqual({ held: "input" });
  });

  it.each([
    {
      expected: [
        resolvedWith("answered", { optionId: "continue", requestId: BUDGET.requestId }),
        { type: "budget.granted" },
      ],
      intake: answer("continue"),
      name: "Continue grants a fresh budget window",
    },
    {
      expected: [
        resolvedWith("answered", { optionId: "stop", requestId: BUDGET.requestId }),
        { requestId: BUDGET.requestId, type: "budget.declined" },
      ],
      intake: answer("stop"),
      name: "Stop declines, once, and cancels the turn",
    },
    {
      expected: [
        { type: "message.answered" },
        resolvedWith("answered", { optionId: "continue", requestId: BUDGET.requestId }),
        { type: "budget.granted" },
      ],
      intake: { sender: null, text: "approve", type: "message" } satisfies Intake,
      name: "a typed reply that names an option answers it",
    },
    {
      expected: [resolvedWith("cancelled")],
      intake: { type: "cancelled" } satisfies Intake,
      name: "a cancel withdraws it",
    },
  ])("$name", ({ expected, intake }) => {
    const { events, humanInput } = asked().intake(intake);

    expect(events).toEqual(expected);
    expect(humanInput.next()).toEqual({ run: "model" });
    expect(humanInput.write(undefined)).toBeUndefined();
  });

  it.each([
    {
      intake: { sender: null, text: "Also check the invoices.", type: "message" } as Intake,
      name: "a message that answers nothing",
    },
    { intake: answer("maybe"), name: "an answer with neither option" },
  ])("keeps the question open past $name", ({ intake }) => {
    const { events, humanInput } = asked().intake(intake);

    expect(events).toEqual([]);
    expect(humanInput.openRequestIds()).toEqual(new Set([BUDGET.requestId]));
  });

  it("drops a late answer to a budget question that already closed", () => {
    const closed = asked().intake(answer("continue")).humanInput;

    expect(closed.intake(answer("stop")).events).toEqual([]);
  });
});
