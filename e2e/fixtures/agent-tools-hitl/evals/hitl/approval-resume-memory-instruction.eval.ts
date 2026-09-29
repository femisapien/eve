import { defineEval } from "eve/evals";

const MARKER = "approval-memory-instruction-P8R2";
const TOOL_NAME = "gate";

export default defineEval({
  description:
    "An approved tool executes when empty memory recall and user-role instructions run on resume.",
  async test(t) {
    const parked = await t.send(`Call the ${TOOL_NAME} tool exactly once with marker "${MARKER}".`);
    parked.calledTool(TOOL_NAME, { count: 1, status: "pending" });
    const approval = parked.session.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    const approved = await parked.session.respond([
      { optionId: "approve", requestId: approval.requestId },
    ]);
    approved.expectOk();
    approved.event("action.result", {
      count: 1,
      data: {
        result: {
          kind: "tool-result",
          output: new RegExp(MARKER),
          toolName: TOOL_NAME,
        },
        status: "completed",
      },
    });
    t.succeeded();
  },
});
