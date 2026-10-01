import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A gated workflow call becomes a task whose body starts only after approval and never after a denial.",
  async test(t) {
    const review = await t.session();
    const denied = await review.send(
      "WORKFLOW-APPROVAL-DENIED-START Alice requests a review-only release; Bob's policy does not permit deployment.",
    );
    denied.expectOk();
    denied.messageIncludes("WORKFLOW-APPROVAL-DENIED-RESULT");
    denied.notEvent("input.requested");
    denied.notEvent("action.partial");
    denied.calledTool("gated_deploy", {
      count: 1,
      output: /Tool execution was denied/u,
      status: "failed",
    });

    for (const decision of ["approve", "cancel"] as const) {
      const session = await t.session();
      const asked = await session.send(
        "WORKFLOW-APPROVAL-START Alice asks Bob to review the API release before deployment.",
      );
      asked.expectOk();
      asked.event("task.started", { count: 1, data: { name: "gated_deploy" } });
      session.requireInputRequest({ display: "confirmation", toolName: "gated_deploy" });
      asked.notEvent("action.partial");

      const answered = await session.respondAll(decision);
      answered.expectOk();
      if (decision === "approve") {
        answered.event("input.resolved", {
          count: 1,
          data: { resolutions: [{ outcome: "approved" }] },
        });
        answered.event("task.settled", {
          count: 1,
          data: { name: "gated_deploy", output: { deployed: "api" }, status: "completed" },
        });
      } else {
        answered.event("input.resolved", {
          count: 1,
          data: { resolutions: [{ outcome: "denied" }] },
        });
        answered.event("task.settled", {
          count: 1,
          data: { name: "gated_deploy", status: "failed" },
        });
        answered.notEvent("action.partial");
      }
    }
  },
});
