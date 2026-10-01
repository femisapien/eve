import { defineEval } from "eve/evals";
import type { EveEvalContext, EveEvalSession } from "eve/evals";

const GOOG_PRICE = "178.92";

/**
 * Alice asks the stock-price agent for a quote. Its lookup needs a person's
 * approval, which reaches her on the parent session; once she approves, the
 * child's lookup runs and the quote comes back in the parent's reply.
 */
export default defineEval({
  description: "A child's gated call is approved through the parent session.",
  timeoutMs: 90_000,
  async test(t) {
    const started = await t.send(
      `Call the stock-price subagent exactly once with message 'Call the get_stock_price tool exactly once with ticker "GOOG". After it returns, do not call any tool again; return the result.'. After that single subagent call finishes, do not call any subagent or tool again; include the exact stock price in your final reply.`,
    );
    const asked = await waitForApproval(t, started.session);
    asked.requireInputRequest({ display: "confirmation", toolName: "get_stock_price" });

    const approved = await asked.respondAll("approve");
    approved.noFailedActions();
    approved.messageIncludes(GOOG_PRICE);
    t.calledSubagent("stock-price", { count: 1, status: "completed" });
  },
});

async function waitForApproval(
  t: EveEvalContext,
  initial: EveEvalSession,
): Promise<EveEvalSession> {
  let session = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.pendingInputRequests.some((request) => request.kind === "tool-approval")) {
      return session;
    }
    if (session.sessionId === undefined || session.state === undefined) break;
    const turn = await t.target
      .watchTurn(session.sessionId, { startIndex: session.state.streamIndex })
      .result();
    session = turn.session;
  }
  throw new Error("The child's approval never reached the parent session.");
}
