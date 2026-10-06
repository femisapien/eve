import { describe, expect, it } from "vitest";

import {
  ALICE,
  Turn,
  answer,
  approval,
  approvalsRequested,
  callback,
  cancel,
  challenge,
  waitingOnAuthorizations,
  message,
  authorizationRequired,
} from "#internal/testing/hitl.js";

/** How each authorization the turn reported ended. */
function outcomes(turn: Turn) {
  return turn.published("authorization.completed").map(({ data }) => ({
    attemptId: data.attemptId,
    outcome: data.outcome,
    reason: data.reason,
  }));
}

const SUPERSEDED = "Superseded by a newer authorization attempt.";

describe("authorizations", () => {
  it("an authorization publishes one authorization per challenge and the turn waits", () => {
    const turn = waitingOnAuthorizations(challenge("a1"));

    expect(turn.published("authorization.required").map(({ data }) => data)).toEqual([
      expect.objectContaining({
        attemptId: "a1",
        name: "weather",
        principalId: "alice",
        webhookUrl: "https://agent.example/callback/a1",
      }),
    ]);
    expect(turn.stored().next()).toEqual({ waiting: "input" });
    expect(turn.stored().humanInput.awaitedAuthorizations()).toEqual(["a1"]);
  });

  it("the step joins history without the calls that asked, so history never holds a waiting call", () => {
    const weather = {
      input: {},
      toolCallId: "call-weather",
      toolName: "weather",
      type: "tool-call" as const,
    };
    const clock = {
      input: {},
      toolCallId: "call-clock",
      toolName: "clock",
      type: "tool-call" as const,
    };
    const result = (call: typeof weather, value: string) => ({
      output: { type: "text" as const, value },
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      type: "tool-result" as const,
    });
    const turn = Turn.idle().input(
      authorizationRequired(
        [challenge("a1")],
        ["call-weather"],
        [
          { content: [weather, clock], role: "assistant" },
          { content: [result(weather, "Authorize first."), result(clock, "noon")], role: "tool" },
        ],
      ),
    );

    expect(turn.events.filter((event) => event.type === "appendHistory")).toEqual([
      { message: { content: [clock], role: "assistant" }, type: "appendHistory" },
      { message: { content: [result(clock, "noon")], role: "tool" }, type: "appendHistory" },
    ]);
  });

  describe("a step held on an approval", () => {
    const probe = {
      input: {},
      toolCallId: "call-probe",
      toolName: "auth-probe",
      type: "tool-call" as const,
    };
    const publish = approval("publish");
    const publishCall = {
      input: {},
      toolCallId: publish.action!.callId,
      toolName: "publish",
      type: "tool-call" as const,
    };
    const signal = {
      output: { type: "json" as const, value: { authorization: true } },
      toolCallId: probe.toolCallId,
      toolName: probe.toolName,
      type: "tool-result" as const,
    };
    /** One step checked Alice's access (an authorization) and asked to publish (an approval). */
    const step = [
      { content: [probe, publishCall], role: "assistant" as const },
      { content: [signal], role: "tool" as const },
    ];
    const held = Turn.idle()
      .input(approvalsRequested([publish], { messages: step }))
      .input(authorizationRequired([challenge("a1")], [probe.toolCallId]));

    it("stays held without the call that asked, so the waiting call never enters history", () => {
      expect(held.appended()).toEqual([]);
      expect(held.humanInput.heldMessages()).toEqual([
        { content: [publishCall], role: "assistant" },
      ]);
      expect(held.stored().next()).toEqual({ waiting: "input" });
    });

    it("a cancel appends the step with a not-run result for the waiting call", () => {
      const cancelled = held.input(cancel);

      expect(cancelled.appended()).toEqual([
        { content: [publishCall], role: "assistant" },
        {
          content: [
            expect.objectContaining({ toolCallId: publishCall.toolCallId, type: "tool-result" }),
          ],
          role: "tool",
        },
      ]);
      expect(cancelled.storesNothing()).toBe(true);
    });

    it("the approved call's own authorization leaves the step too, and the turn waits on the newer attempt", () => {
      const approved = held.input(answer("approve", publish.requestId));
      expect(approved.approvedCalls()?.requests).toHaveLength(1);

      // The settle opens the call's authorization; no step response comes with it.
      const resumed = approved.input({
        approved: {},
        results: [],
        running: [],
        authorizations: { callIds: [publishCall.toolCallId], challenges: [challenge("a2")] },
        type: "actions.settled",
      });

      expect(resumed.appended()).toEqual([]);
      expect(resumed.humanInput.heldMessages()).toEqual([]);
      expect(outcomes(resumed)).toEqual([
        { attemptId: "a1", outcome: "failed", reason: SUPERSEDED },
      ]);
      expect(resumed.stored().next()).toEqual({ waiting: "input" });
    });
  });

  it("only a callback closes an authorization, so no answer is routed to it", () => {
    expect(waitingOnAuthorizations(challenge("a1")).humanInput.openRequestIds()).toEqual(new Set());
  });

  it("a newer attempt of the same authorization for the same person replaces the older one", () => {
    const bobs = challenge("bobs", { principal: { id: "bob", issuer: "test", type: "user" } });
    const turn = waitingOnAuthorizations(
      challenge("first"),
      bobs,
      challenge("connector", { grant: "vercel-connect:github", name: "github-tool" }),
    ).input(
      // The same name, or another scope of the same grant, is the same authorization.
      authorizationRequired([
        challenge("second"),
        challenge("again", { grant: "vercel-connect:github", name: "github-connection" }),
      ]),
    );

    expect(outcomes(turn)).toEqual([
      { attemptId: "first", outcome: "failed", reason: SUPERSEDED },
      { attemptId: "connector", outcome: "failed", reason: SUPERSEDED },
    ]);
    expect(turn.humanInput.awaitedAuthorizations()).toEqual(["bobs", "second", "again"]);
  });

  it("an authorization asked twice in one step waits only on the latest attempt", () => {
    const turn = Turn.idle().input(
      authorizationRequired([challenge("older"), challenge("newer")], ["call-1", "call-2"]),
    );

    expect(turn.published("authorization.required")).toHaveLength(1);
    expect(turn.humanInput.awaitedAuthorizations()).toEqual(["newer"]);
  });

  it("a callback completes its authorization and the call resumes as the person who started the turn", () => {
    const turn = waitingOnAuthorizations(challenge("a1")).input(callback("a1"));

    expect(outcomes(turn)).toEqual([{ attemptId: "a1", outcome: "authorized", reason: undefined }]);
    expect(turn.reported("resumeAuthorization")).toEqual([
      {
        requester: ALICE,
        result: {
          attemptId: "a1",
          callback: { method: "GET", params: { code: "ok" } },
          hookUrl: "https://agent.example/callback/a1",
          instanceId: undefined,
          name: "weather",
          principal: { id: "alice", issuer: "test", type: "user" },
          resume: { nonce: "a1" },
        },
        type: "resumeAuthorization",
      },
    ]);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("the turn keeps waiting until every authorization it waits on completes", () => {
    const turn = waitingOnAuthorizations(
      challenge("a1"),
      challenge("c1", { name: "calendar" }),
    ).input(callback("a1"));

    expect(turn.next()).toEqual({ waiting: "input" });
    expect(turn.input(callback("c1", "calendar")).next()).toEqual({ run: "model" });
  });

  it("a callback for an attempt that is not open completes nothing", () => {
    const open = waitingOnAuthorizations(challenge("a1"));
    const replaced = open.input(authorizationRequired([challenge("a2")]));

    expect(open.input(callback("a1")).input(callback("a1")).events).toEqual([]);
    expect(open.input(callback("a1", "calendar")).events).toEqual([]);
    expect(replaced.input(callback("a1")).events).toEqual([]);
    expect(replaced.input(callback("a1")).next()).toEqual({ waiting: "input" });
  });

  it("a callback that can't be read fails the authorization without handing it to the call", () => {
    const turn = waitingOnAuthorizations(challenge("a1")).input({
      attemptId: "a1",
      connectionName: "weather",
      outcome: "failed",
      type: "authorization.completed",
    });

    expect(outcomes(turn)).toEqual([{ attemptId: "a1", outcome: "failed", reason: undefined }]);
    expect(turn.reported("resumeAuthorization")).toEqual([]);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("a message declines the open authorizations and tells the model which ended", () => {
    const turn = waitingOnAuthorizations(challenge("a1")).input(message("Never mind."));

    expect(outcomes(turn)).toEqual([
      { attemptId: "a1", outcome: "declined", reason: "Cancelled because a new message arrived." },
    ]);
    expect(turn.reported("addNote")).toEqual([
      { text: expect.stringContaining("Sign-in to weather was cancelled"), type: "addNote" },
    ]);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("a cancel declines the open authorizations", () => {
    const turn = waitingOnAuthorizations(challenge("a1")).input(cancel);

    expect(outcomes(turn)).toEqual([
      { attemptId: "a1", outcome: "declined", reason: "Cancelled." },
    ]);
    expect(turn.storesNothing()).toBe(true);
  });
});
