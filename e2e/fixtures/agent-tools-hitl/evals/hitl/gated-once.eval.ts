import { defineEval } from "eve/evals";

const FIRST = "gated-once-first-H5T1";
const SECOND = "gated-once-second-H5T2";

/** After Alice approves a `once()` tool, later calls in her session run without asking. */
export default defineEval({
  description: "once() asks for the first call only.",
  async test(t) {
    const asked = await t.send(`Call the guarded-echo tool exactly once with marker "${FIRST}".`);
    asked.expectOk();
    const approved = await asked.session.respondAll("approve");
    approved.expectOk();
    approved.event("task.settled", { count: 1, data: { status: "completed" } });

    const again = await approved.session.send(
      `Call the guarded-echo tool exactly once with marker "${SECOND}".`,
    );
    again.expectOk();
    again.notEvent("input.requested");
    again.notEvent("task.started");
    again.calledTool("guarded-echo", { count: 1, status: "completed" });
    again.messageIncludes("guarded-echo-ok-T4Q9");
  },
});
