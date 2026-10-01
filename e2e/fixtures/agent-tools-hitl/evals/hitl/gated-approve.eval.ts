import { defineEval } from "eve/evals";

const MARKER = "gated-approve-N4K7";

/**
 * Alice asks for a gated call. The model gets a receipt at once and tells her
 * it's waiting; the call runs only after she approves, and its result reaches
 * the model in the same turn.
 */
export default defineEval({
  description: "An approved gated call runs as a task and its result reaches the model.",
  async test(t) {
    const asked = await t.send(`Call the gate tool exactly once with marker "${MARKER}".`);
    asked.expectOk();
    asked.event("task.started", { count: 1, data: { name: "gate" } });
    asked.notEvent("task.settled");
    const approval = asked.session.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "cancel"],
      toolName: "gate",
    });

    const approved = await asked.session.respond([
      { optionId: "approve", requestId: approval.requestId },
    ]);
    approved.expectOk();
    approved.event("input.resolved", {
      count: 1,
      data: { resolutions: [{ outcome: "approved", requestId: approval.requestId }] },
    });
    approved.event("task.settled", { count: 1, data: { name: "gate", status: "completed" } });
    approved.event("turn.completed", { count: 1 });
    approved.messageIncludes(MARKER);
  },
});
