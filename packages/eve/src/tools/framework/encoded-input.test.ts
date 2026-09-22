import { describe, expect, it } from "vitest";

import { ASK_QUESTION_INPUT_SCHEMA } from "#tools/framework/ask-question.js";
import { SUBAGENT_TOOL_INPUT_SCHEMA } from "#tools/framework/agent-contract.js";
import { TASK_CANCEL_INPUT_SCHEMA } from "#tools/framework/task-contract.js";

describe("framework tool schemas", () => {
  it("accepts JSON-encoded nested values from model tool calls", () => {
    expect(
      SUBAGENT_TOOL_INPUT_SCHEMA.safeParse({
        message: "Return a result.",
        outputSchema: JSON.stringify({ type: "object" }),
      }).success,
    ).toBe(true);

    expect(
      ASK_QUESTION_INPUT_SCHEMA.safeParse({
        options: JSON.stringify([{ id: "yes", label: "Yes" }]),
        prompt: "Continue?",
      }).success,
    ).toBe(true);

    expect(
      TASK_CANCEL_INPUT_SCHEMA.safeParse({ taskIds: JSON.stringify(["task-1"]) }).success,
    ).toBe(true);
  });
});
