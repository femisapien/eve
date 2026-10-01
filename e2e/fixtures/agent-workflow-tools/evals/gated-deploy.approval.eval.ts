import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A workflow body never starts when its approval policy denies the call or asks for a person.",
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

    const release = await t.session();
    const unanswerable = await release.send(
      "WORKFLOW-APPROVAL-START Alice asks Bob to review the API release before deployment.",
    );
    unanswerable.expectOk();
    unanswerable.messageIncludes("WORKFLOW-APPROVAL-RESULT");
    unanswerable.notEvent("input.requested");
    unanswerable.notEvent("action.partial");
    unanswerable.calledTool("gated_deploy", {
      count: 1,
      output: /needs a person's approval/u,
      status: "failed",
    });
  },
});
