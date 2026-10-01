import { defineEval } from "eve/evals";

const MARKER = "gated-cancel-R2W8";

/** Bob declines Alice's gated call, so it never runs and the model hears why. */
export default defineEval({
  description: "A declined gated call settles its task as failed without running.",
  async test(t) {
    const asked = await t.send(`Call the gate tool exactly once with marker "${MARKER}".`);
    asked.expectOk();
    asked.session.requireInputRequest({ toolName: "gate" });

    const declined = await asked.session.respondAll("cancel");
    declined.expectOk();
    declined.event("input.resolved", { count: 1, data: { resolutions: [{ outcome: "denied" }] } });
    declined.event("task.settled", { count: 1, data: { name: "gate", status: "failed" } });
    declined.notEvent("task.settled", { data: { status: "completed" } });
    declined.messageIncludes("declined");
  },
});
