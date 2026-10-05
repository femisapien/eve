import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  asBob,
  expectNotRun,
  expectResolved,
  authorizationFrom,
} from "../helpers.ts";

/**
 * The OAuth-checked change's policy needs an approver to authorize, but lets
 * anyone cancel. Bob approves and is asked to authorize, so his candidate waits.
 * Alice cancels meanwhile: her candidate settles the approval, Bob's goes
 * stale and his authorization is declined, and his late callback runs nothing.
 */
export default defineEval({
  description: "The candidate that settles an approval makes its competitors stale.",
  tags: ["hitl", "authorization", "authorization"],
  timeoutMs: 90_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(
      await session.send(SAY.oauthChecked, asAlice),
      "oauth-authorized-gate",
    );

    const waiting = await session.respond(answers("approve", request), asBob);
    waiting.event("approval.candidate", { count: 1, data: { outcome: "pending" } });
    waiting.event("authorization.required", { count: 1, data: { principalId: "bob" } });
    const bobAuthorization = authorizationFrom(waiting);

    const cancelled = (await session.respond(answers("cancel", request), asAlice)).expectOk();
    cancelled.event("approval.settled", {
      count: 1,
      data: { outcome: "cancelled", requestId: request.requestId, responderPrincipalId: "alice" },
    });
    cancelled.event("approval.candidate", {
      count: 1,
      data: {
        outcome: "stale",
        reason: "Another response settled this approval.",
        responderPrincipalId: "bob",
      },
    });
    cancelled.event("authorization.completed", {
      count: 1,
      data: { attemptId: bobAuthorization.attemptId, outcome: "declined" },
    });
    expectResolved(cancelled, request, "denied");
    expectNotRun(cancelled, "oauth-authorized-gate");

    // Bob finishes authorizing too late: the attempt is closed, so nothing runs.
    // The callback endpoint may refuse the closed attempt; either way it completes nothing.
    await fetch(bobAuthorization.url);
    const late = (await session.send(SAY.bobStatus, asBob)).expectOk();
    late.notEvent("approval.settled");
    late.notEvent("action.result", { data: { status: "completed" } });
    session.notEvent("authorization.completed", { data: { outcome: "authorized" } });
    session.notEvent("action.result", {
      data: { status: "completed", result: { toolName: "oauth-authorized-gate" } },
    });
  },
});
