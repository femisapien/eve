import { describe, expect, it } from "vitest";

import { HumanInput } from "#harness/human-input/index.js";

const AT = { sequence: 1, stepIndex: 0, turnId: "turn_1" };

describe("HumanInput", () => {
  it("runs the model when nothing is open, and leaves no state behind", () => {
    const humanInput = HumanInput.read(undefined);

    expect(humanInput.next()).toEqual({ run: "model" });
    expect(humanInput.write({ other: 1 })).toEqual({ other: 1 });
  });

  it("fails a turn that needs a person until that case is rebuilt", () => {
    const { events, humanInput } = HumanInput.read(undefined).interrupt({
      at: AT,
      request: {
        action: { callId: "limit", input: {}, kind: "tool-call", toolName: "session-limit" },
        kind: "session-limit",
        options: [{ id: "continue", label: "Continue" }],
        prompt: "Alice's session is over budget. Continue?",
        requestId: "limit-1",
      },
      canAsk: true,
      type: "budget.exceeded",
    });

    expect(events).toEqual([
      expect.objectContaining({ code: "HUMAN_INPUT_UNAVAILABLE", type: "turn.failed" }),
    ]);
    expect(humanInput.next()).toEqual({ run: "model" });
  });
});
