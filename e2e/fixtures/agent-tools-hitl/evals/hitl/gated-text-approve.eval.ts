import { defineEval } from "eve/evals";

const MARKER = "gated-text-approve-P6J3";

/**
 * Alice approves by typing "approve" instead of pressing a button. With one
 * approval open, the message answers it and never reaches the model, so the
 * held turn goes on rather than a new one starting.
 */
export default defineEval({
  description: "A plain-text approve answers the one open approval.",
  timeoutMs: 90_000,
  async test(t) {
    const asked = await t.send(`Call the gate tool exactly once with marker "${MARKER}".`);
    asked.expectOk();
    const { session } = asked;
    session.requireInputRequest({ toolName: "gate" });
    if (session.sessionId === undefined || session.state === undefined) {
      throw new Error("The gated call's session has no stream cursor.");
    }

    const held = t.target.watchTurn(session.sessionId, {
      startIndex: session.state.streamIndex,
    });
    const reply = await session.start("approve");
    const approved = await held.result();
    await reply.cancel();

    approved.expectOk();
    approved.notEvent("message.received");
    approved.event("input.resolved", {
      count: 1,
      data: { resolutions: [{ outcome: "approved" }] },
    });
    approved.event("task.settled", { count: 1, data: { name: "gate", status: "completed" } });
    approved.messageIncludes(MARKER);
  },
});
