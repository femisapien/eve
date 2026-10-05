import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  as,
  asAlice,
  completeSignIn,
  expectHeld,
  expectNoModelCallDuringSignIn,
  expectResolved,
  follow,
  signInFrom,
} from "../helpers.ts";

// A responder of its own: the fixture's sign-ins outlive an eval, and other
// evals sign the default release manager in.
const RESPONDER = "human-input-sign-in-responder";

/**
 * A responder approves the OAuth-checked change. Its policy needs the
 * approver signed in first, so the turn holds on the responder's sign-in;
 * the callback runs the policy again, which settles the approval as the
 * responder and runs the change.
 */
export default defineEval({
  description: "A response policy that needs the responder to sign in settles after the sign-in.",
  tags: ["hitl", "human-input", "authorization", "sign-in"],
  timeoutMs: 90_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(
      await session.send(SAY.oauthChecked, asAlice),
      "oauth-authorized-gate",
    );

    const held = await session.respond(answers("approve", request), as(RESPONDER));
    expectHeld(held);
    held.event("approval.candidate", { count: 1, data: { outcome: "pending" } });
    held.event("authorization.required", { count: 1, data: { principalId: RESPONDER } });
    held.notEvent("approval.settled");
    const signIn = signInFrom(held);

    const startIndex = session.state.streamIndex;
    await completeSignIn(signIn.url);
    const resumed = (await follow(t, session, startIndex)).expectOk();
    resumed.notEvent("turn.started");
    resumed.eventOrder([
      {
        type: "authorization.completed",
        data: { attemptId: signIn.attemptId, outcome: "authorized" },
      },
      {
        type: "approval.settled",
        data: { outcome: "approved", responderPrincipalId: RESPONDER },
      },
      {
        type: "action.result",
        data: { status: "completed", result: { toolName: "oauth-authorized-gate" } },
      },
      { type: "message.completed", data: { message: /^OAuth-checked change: done / } },
      { type: "turn.completed" },
    ]);
    expectResolved(resumed, request, "approved");
    expectNoModelCallDuringSignIn(resumed, signIn.attemptId, held.events);
  },
});
