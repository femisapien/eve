import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import {
  HumanInput,
  type HumanInputEvent,
  type Intake,
  type Interrupt,
} from "#harness/human-input/index.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";

const AT = { sequence: 1, stepIndex: 0, turnId: "turn_1" };
const NOW = 1_000_000;

const BUDGET: InputRequest = {
  action: { callId: "s:limit:input:12", input: {}, kind: "tool-call", toolName: "session-limit" },
  kind: "session-limit",
  options: [
    { id: "continue", label: "Approve" },
    { id: "stop", label: "Stop" },
  ],
  prompt: "Alice's session is over budget. Continue?",
  requestId: "s:limit:input:12",
};

function asked(request: InputRequest = BUDGET): HumanInput {
  return HumanInput.read(undefined).interrupt({ at: AT, request, type: "budget.exceeded" })
    .humanInput;
}

function answer(optionId: string, requestId = BUDGET.requestId): Intake {
  return { responder: null, responses: [{ optionId, requestId }], now: NOW, type: "answered" };
}

function resolvedWith(outcome: string, response?: unknown) {
  return {
    event: {
      data: {
        ...AT,
        resolutions: [
          {
            kind: "session-limit",
            outcome,
            requestId: BUDGET.requestId,
            ...(response !== undefined && { response }),
          },
        ],
      },
      type: "input.resolved",
    },
    type: "publish",
  };
}

const ALICE: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user",
};

function approval(requestId: string, toolName = "deploy"): InputRequest {
  return {
    action: { callId: `call-${requestId}`, input: {}, kind: "tool-call", toolName },
    allowFreeform: false,
    display: "confirmation",
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: `Alice asks to run ${toolName}.`,
    requestId,
  };
}

function requested(
  requests: readonly InputRequest[],
  options: Partial<Extract<Interrupt, { type: "approvals.requested" }>> = {},
): Interrupt {
  return {
    approvalKeys: {},
    at: AT,
    requester: ALICE,
    requests,
    responsePolicyRequestIds: [],
    type: "approvals.requested",
    ...options,
  };
}

/** A session with these approvals open. */
function waiting(...requests: InputRequest[]): HumanInput {
  return HumanInput.read(undefined).interrupt(requested(requests)).humanInput;
}

function published<T extends UnstampedMessageStreamEvent["type"]>(
  events: readonly HumanInputEvent[],
  type: T,
): Extract<UnstampedMessageStreamEvent, { type: T }>[] {
  return events.flatMap((event) =>
    event.type === "publish" && event.event.type === type
      ? [event.event as Extract<UnstampedMessageStreamEvent, { type: T }>]
      : [],
  );
}

function appended(events: readonly HumanInputEvent[]) {
  return events.flatMap((event) => (event.type === "history.appended" ? [event.message] : []));
}

describe("HumanInput", () => {
  it("runs the model when nothing is open, and leaves no state behind", () => {
    const humanInput = HumanInput.read(undefined);

    expect(humanInput.next()).toEqual({ run: "model" });
    expect(humanInput.write({ other: 1 })).toEqual({ other: 1 });
  });

  it("fails a turn that needs a person until that case is rebuilt", () => {
    const { events, humanInput } = HumanInput.read(undefined).interrupt({
      at: AT,
      requests: [BUDGET],
      route: { childContinuationToken: "child" },
      type: "relayed.requested",
    });

    expect(events).toEqual([
      expect.objectContaining({ code: "HUMAN_INPUT_UNAVAILABLE", type: "turn.failed" }),
    ]);
    expect(humanInput.next()).toEqual({ run: "model" });
  });

  describe("tool approvals", () => {
    it("opens one request per approval, asks at the step's coordinates, and holds the turn", () => {
      const { events, humanInput } = HumanInput.read(undefined).interrupt(
        requested([approval("a"), approval("b")]),
      );

      expect(events).toEqual([
        {
          event: {
            data: { ...AT, requests: [approval("a"), approval("b")] },
            type: "input.requested",
          },
          type: "publish",
        },
      ]);
      expect(humanInput.next()).toEqual({ held: "input" });
      expect(humanInput.openRequestIds()).toEqual(new Set(["a", "b"]));
      // The open approvals survive the session's state round trip.
      expect(HumanInput.read(humanInput.write(undefined)).openRequestIds()).toEqual(
        new Set(["a", "b"]),
      );
    });

    it("keeps a partial answer and holds the turn until every approval of the step is answered", () => {
      const partial = waiting(approval("a"), approval("b")).intake({
        responder: ALICE,
        responses: [{ optionId: "approve", requestId: "a" }],
        now: NOW,
        type: "answered",
      });

      expect(partial.events).toEqual([]);
      expect(partial.humanInput.next()).toEqual({ held: "input" });

      const rest = HumanInput.read(partial.humanInput.write(undefined)).intake({
        responder: ALICE,
        responses: [{ optionId: "approve", requestId: "b" }],
        now: NOW,
        type: "answered",
      });

      expect(published(rest.events, "input.resolved")).toEqual([
        {
          data: {
            ...AT,
            resolutions: [
              {
                kind: "tool-approval",
                outcome: "approved",
                requestId: "a",
                response: { optionId: "approve", requestId: "a" },
              },
              {
                kind: "tool-approval",
                outcome: "approved",
                requestId: "b",
                response: { optionId: "approve", requestId: "b" },
              },
            ],
          },
          type: "input.resolved",
        },
      ]);
      expect(rest.humanInput.next()).toEqual({ run: "model" });
    });

    it("runs approved calls and answers denied and invalid ones with a not-run result", () => {
      const { events } = waiting(
        approval("ok"),
        approval("no"),
        approval("deny"),
        approval("x"),
      ).intake({
        responder: ALICE,
        responses: [
          { optionId: "approve", requestId: "ok" },
          { optionId: "cancel", requestId: "no" },
          { optionId: "deny", requestId: "deny" },
          { optionId: "maybe", requestId: "x" },
        ],
        now: NOW,
        type: "answered",
      });

      expect(
        published(events, "input.resolved").flatMap((event) =>
          event.type === "input.resolved"
            ? event.data.resolutions.map((resolution) => resolution.outcome)
            : [],
        ),
      ).toEqual(["approved", "denied", "denied", "invalid"]);
      expect(events.filter((event) => event.type === "calls.approved")).toEqual([
        { at: AT, requests: [approval("ok")], type: "calls.approved" },
      ]);
      expect(appended(events)).toEqual([
        {
          content: [
            {
              output: { reason: "Tool execution was denied.", type: "execution-denied" },
              toolCallId: "call-no",
              toolName: "deploy",
              type: "tool-result",
            },
            {
              output: { reason: "Tool execution was denied.", type: "execution-denied" },
              toolCallId: "call-deny",
              toolName: "deploy",
              type: "tool-result",
            },
            {
              output: { reason: "Invalid approval response.", type: "execution-denied" },
              toolCallId: "call-x",
              toolName: "deploy",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ]);
      expect(published(events, "action.result")).toEqual(
        ["no", "deny", "x"].map((requestId) =>
          expect.objectContaining({
            data: expect.objectContaining({
              error: expect.objectContaining({ code: "TOOL_EXECUTION_DENIED" }),
              result: expect.objectContaining({
                callId: `call-${requestId}`,
                output: expect.objectContaining({
                  approval: {
                    requestId,
                    status: requestId === "x" ? "invalid" : "denied",
                  },
                  tool: { result: "not_run" },
                }),
              }),
              status: "rejected",
            }),
          }),
        ),
      );
    });

    it("takes the last answer to a request", () => {
      const { events } = waiting(approval("a")).intake({
        responder: ALICE,
        responses: [
          { optionId: "approve", requestId: "a" },
          { optionId: "cancel", requestId: "a" },
        ],
        now: NOW,
        type: "answered",
      });

      expect(events.some((event) => event.type === "calls.approved")).toBe(false);
      expect(published(events, "input.resolved")).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            resolutions: [expect.objectContaining({ outcome: "denied", requestId: "a" })],
          }),
        }),
      ]);
    });

    it("answers the approvals a typed reply matches, and the turn doesn't read the reply", () => {
      const typed = waiting(approval("a")).intake({
        sender: ALICE,
        text: "Approve",
        type: "message",
      });

      expect(typed.events[0]).toEqual({ type: "message.answered" });
      expect(typed.events.some((event) => event.type === "calls.approved")).toBe(true);
      expect(typed.humanInput.next()).toEqual({ run: "model" });
    });

    it("steers past unanswered approvals with any other message, keeping the answers given", () => {
      const partial = waiting(approval("a"), approval("b")).intake({
        responder: ALICE,
        responses: [{ optionId: "approve", requestId: "a" }],
        now: NOW,
        type: "answered",
      }).humanInput;

      const { events, humanInput } = partial.intake({
        sender: ALICE,
        text: "Never mind, check the draft status instead.",
        type: "message",
      });

      expect(events.some((event) => event.type === "message.answered")).toBe(false);
      expect(published(events, "input.resolved")).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            resolutions: [
              expect.objectContaining({ outcome: "approved", requestId: "a" }),
              { kind: "tool-approval", outcome: "ignored", requestId: "b" },
            ],
          }),
        }),
      ]);
      expect(events.filter((event) => event.type === "calls.approved")).toEqual([
        { at: AT, requests: [approval("a")], type: "calls.approved" },
      ]);
      expect(appended(events)).toEqual([
        {
          content: [
            {
              output: {
                reason: "Ignored because the user continued without responding.",
                type: "execution-denied",
              },
              toolCallId: "call-b",
              toolName: "deploy",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ]);
      expect(humanInput.next()).toEqual({ run: "model" });
    });

    it("cancels every open approval at its own coordinates when the turn is cancelled", () => {
      const later = { sequence: 4, stepIndex: 2, turnId: "turn_1" };
      const open = HumanInput.read(undefined).interrupt(
        requested([approval("a")], { at: later }),
      ).humanInput;

      const { events, humanInput } = open.intake({ type: "cancelled" });

      expect(published(events, "input.resolved")).toEqual([
        {
          data: {
            ...later,
            resolutions: [{ kind: "tool-approval", outcome: "cancelled", requestId: "a" }],
          },
          type: "input.resolved",
        },
      ]);
      expect(appended(events)).toEqual([
        {
          content: [
            {
              output: { reason: "Cancelled before anyone answered.", type: "execution-denied" },
              toolCallId: "call-a",
              toolName: "deploy",
              type: "tool-result",
            },
          ],
          role: "tool",
        },
      ]);
      expect(humanInput.openRequestIds().size).toBe(0);
    });

    it("adds the approved calls' results to history once the runtime ran them", () => {
      const results = [
        {
          content: [
            {
              output: { type: "json" as const, value: { ok: true } },
              toolCallId: "call-a",
              toolName: "deploy",
              type: "tool-result" as const,
            },
          ],
          role: "tool" as const,
        },
      ];

      const { events } = HumanInput.read(undefined).intake({ results, type: "calls.settled" });

      expect(appended(events)).toEqual(results);
    });

    it("grants a once() approval's key, hidden while an approval for that key waits", () => {
      const approved = HumanInput.read(undefined)
        .interrupt(requested([approval("a")], { approvalKeys: { a: "deploy:api" } }))
        .humanInput.intake({
          responder: ALICE,
          responses: [{ optionId: "approve", requestId: "a" }],
          now: NOW,
          type: "answered",
        }).humanInput;

      expect(approved.grantedApprovalKeys()).toEqual(new Set(["deploy:api"]));

      const askedAgain = approved.interrupt(
        requested([approval("b")], { approvalKeys: { b: "deploy:api" } }),
      ).humanInput;
      expect(askedAgain.grantedApprovalKeys()).toEqual(new Set());
    });
  });

  it("turns an answer to a request that is no longer open into text that authorizes nothing", () => {
    const humanInput = waiting(approval("open"));

    const { displayMessage, input } = humanInput.acceptInput({
      inputResponses: [
        { optionId: "approve", requestId: "closed" },
        { optionId: "approve", requestId: "open" },
      ],
    });

    expect(input?.inputResponses).toEqual([{ optionId: "approve", requestId: "open" }]);
    expect(input?.message).toEqual(
      expect.stringContaining("This does not authorize an earlier action"),
    );
    expect(displayMessage).toBe("approve");
  });
});

describe("the budget question", () => {
  it("asks once per violation and holds the turn until it is answered", () => {
    const first = HumanInput.read(undefined).interrupt({
      at: AT,
      request: BUDGET,
      type: "budget.exceeded",
    });
    expect(first.events).toEqual([
      {
        event: { data: { ...AT, requests: [BUDGET] }, type: "input.requested" },
        type: "publish",
      },
    ]);
    expect(first.humanInput.next()).toEqual({ held: "input" });

    // The state survives the session store, as it would across steps.
    const stored = HumanInput.read(first.humanInput.write(undefined));
    const again = stored.interrupt({
      at: { ...AT, stepIndex: 1 },
      request: BUDGET,
      type: "budget.exceeded",
    });
    expect(again.events).toEqual([]);
    expect(again.humanInput.next()).toEqual({ held: "input" });
  });

  it.each([
    {
      expected: [
        resolvedWith("answered", { optionId: "continue", requestId: BUDGET.requestId }),
        { type: "budget.granted" },
      ],
      intake: answer("continue"),
      name: "Continue grants a fresh budget window",
    },
    {
      expected: [
        resolvedWith("answered", { optionId: "stop", requestId: BUDGET.requestId }),
        { requestId: BUDGET.requestId, type: "budget.declined" },
      ],
      intake: answer("stop"),
      name: "Stop declines, once, and cancels the turn",
    },
    {
      expected: [
        { type: "message.answered" },
        resolvedWith("answered", { optionId: "continue", requestId: BUDGET.requestId }),
        { type: "budget.granted" },
      ],
      intake: { sender: null, text: "approve", type: "message" } satisfies Intake,
      name: "a typed reply that names an option answers it",
    },
    {
      expected: [resolvedWith("cancelled")],
      intake: { type: "cancelled" } satisfies Intake,
      name: "a cancel withdraws it",
    },
  ])("$name", ({ expected, intake }) => {
    const { events, humanInput } = asked().intake(intake);

    expect(events).toEqual(expected);
    expect(humanInput.next()).toEqual({ run: "model" });
    expect(humanInput.write(undefined)).toBeUndefined();
  });

  it.each([
    {
      intake: { sender: null, text: "Also check the invoices.", type: "message" } as Intake,
      name: "a message that answers nothing",
    },
    { intake: answer("maybe"), name: "an answer with neither option" },
  ])("keeps the question open past $name", ({ intake }) => {
    const { events, humanInput } = asked().intake(intake);

    expect(events).toEqual([]);
    expect(humanInput.openRequestIds()).toEqual(new Set([BUDGET.requestId]));
  });

  it("drops a late answer to a budget question that already closed", () => {
    const closed = asked().intake(answer("continue")).humanInput;

    expect(closed.intake(answer("stop")).events).toEqual([]);
  });
});

const BOB: SessionAuthContext = { ...ALICE, principalId: "bob" };
const CAROL: SessionAuthContext = { ...ALICE, principalId: "carol" };

function challenge(
  attemptId: string,
  overrides: Partial<AuthorizationChallenge> = {},
): AuthorizationChallenge {
  return {
    attemptId,
    challenge: { url: `https://idp.example/authorize/${attemptId}` },
    hookUrl: `https://agent.example/callback/${attemptId}`,
    name: "weather",
    principal: { id: "alice", issuer: "test", type: "user" },
    principalId: "alice",
    requester: ALICE,
    resume: { nonce: attemptId },
    ...overrides,
  };
}

function signInRequired(
  challenges: readonly AuthorizationChallenge[],
  callIds: readonly string[] = ["call-weather"],
): Interrupt {
  return { at: AT, callIds, challenges, requester: ALICE, type: "authorization.required" };
}

function callback(attemptId: string, connectionName = "weather"): Intake {
  return {
    attemptId,
    callback: { method: "GET", params: { code: "ok" } },
    connectionName,
    outcome: "authorized",
    type: "authorization.completed",
  };
}

function outcomes(events: readonly HumanInputEvent[]) {
  return published(events, "authorization.completed").map((event) => ({
    attemptId: event.data.attemptId,
    outcome: event.data.outcome,
    reason: event.data.reason,
  }));
}

describe("sign-ins", () => {
  it("opens one sign-in per challenge, stops the calls that asked, and holds the turn", () => {
    const { events, humanInput } = HumanInput.read(undefined).interrupt(
      signInRequired([challenge("a1")]),
    );

    expect(events[0]).toEqual({ callIds: ["call-weather"], type: "calls.stopped" });
    expect(published(events, "authorization.required")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          attemptId: "a1",
          name: "weather",
          principalId: "alice",
          webhookUrl: "https://agent.example/callback/a1",
        }),
      }),
    ]);
    const stored = HumanInput.read(humanInput.write(undefined));
    expect(stored.next()).toEqual({ held: "input" });
    expect(stored.awaitedSignIns()).toEqual(["a1"]);
    // Only a callback closes a sign-in, so no answer is routed to it.
    expect(stored.openRequestIds()).toEqual(new Set());
  });

  it("replaces an older attempt of the same sign-in, and keeps other people's", () => {
    const open = HumanInput.read(undefined).interrupt(
      signInRequired([
        challenge("first"),
        challenge("bobs", { principal: { id: "bob", issuer: "test", type: "user" } }),
        challenge("connector", { grant: "vercel-connect:github", name: "github-tool" }),
      ]),
    ).humanInput;

    // The same name, or another scope of the same grant, for the same person is one sign-in.
    const { events, humanInput } = open.interrupt(
      signInRequired([
        challenge("second"),
        challenge("again", { grant: "vercel-connect:github", name: "github-connection" }),
      ]),
    );

    expect(outcomes(events)).toEqual([
      {
        attemptId: "first",
        outcome: "failed",
        reason: "Superseded by a newer authorization attempt.",
      },
      {
        attemptId: "connector",
        outcome: "failed",
        reason: "Superseded by a newer authorization attempt.",
      },
    ]);
    expect(humanInput.awaitedSignIns()).toEqual(["bobs", "second", "again"]);
  });

  it("keeps only the latest attempt of one sign-in asked twice in a step", () => {
    const { events, humanInput } = HumanInput.read(undefined).interrupt(
      signInRequired([challenge("older"), challenge("newer")], ["call-1", "call-2"]),
    );

    expect(published(events, "authorization.required")).toHaveLength(1);
    expect(humanInput.awaitedSignIns()).toEqual(["newer"]);
  });

  it("completes a sign-in on its callback and resumes as the person who started it", () => {
    const open = HumanInput.read(undefined).interrupt(
      signInRequired([challenge("a1"), challenge("c1", { name: "calendar" })]),
    ).humanInput;

    const first = open.intake(callback("a1"));

    expect(outcomes(first.events)).toEqual([
      { attemptId: "a1", outcome: "authorized", reason: undefined },
    ]);
    expect(first.events).toContainEqual({
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
      type: "sign-in.completed",
    });
    // The turn holds until every sign-in it waits on completes.
    expect(first.humanInput.next()).toEqual({ held: "input" });
    expect(first.humanInput.intake(callback("c1", "calendar")).humanInput.next()).toEqual({
      run: "model",
    });
  });

  it("ignores a callback for an attempt that is no longer open", () => {
    const open = HumanInput.read(undefined).interrupt(signInRequired([challenge("a1")])).humanInput;
    const completed = open.intake(callback("a1")).humanInput;

    // A repeated callback, another connection's, and a superseded attempt's all complete nothing.
    expect(completed.intake(callback("a1")).events).toEqual([]);
    expect(open.intake(callback("a1", "calendar")).events).toEqual([]);
    const replaced = open.interrupt(signInRequired([challenge("a2")])).humanInput;
    expect(replaced.intake(callback("a1")).events).toEqual([]);
    expect(replaced.next()).toEqual({ held: "input" });
  });

  it("fails a sign-in whose callback can't be read, without handing it to the call", () => {
    const open = HumanInput.read(undefined).interrupt(signInRequired([challenge("a1")])).humanInput;

    const { events, humanInput } = open.intake({
      attemptId: "a1",
      connectionName: "weather",
      outcome: "failed",
      type: "authorization.completed",
    });

    expect(outcomes(events)).toEqual([{ attemptId: "a1", outcome: "failed", reason: undefined }]);
    expect(events.some((event) => event.type === "sign-in.completed")).toBe(false);
    expect(humanInput.next()).toEqual({ run: "model" });
  });

  it("declines open sign-ins when the turn is steered or cancelled", () => {
    const open = HumanInput.read(undefined).interrupt(signInRequired([challenge("a1")])).humanInput;

    const steered = open.intake({ sender: ALICE, text: "Never mind.", type: "message" });
    expect(outcomes(steered.events)).toEqual([
      { attemptId: "a1", outcome: "declined", reason: "Cancelled because a new message arrived." },
    ]);
    expect(steered.events).toContainEqual({
      text: expect.stringContaining("Sign-in to weather was cancelled"),
      type: "note",
    });
    expect(steered.humanInput.next()).toEqual({ run: "model" });

    const cancelled = open.intake({ type: "cancelled" });
    expect(outcomes(cancelled.events)).toEqual([
      { attemptId: "a1", outcome: "declined", reason: "Cancelled." },
    ]);
    expect(cancelled.humanInput.write(undefined)).toBeUndefined();
  });
});

describe("approval response policies", () => {
  /** Alice's approval of `deploy`, which a response policy guards. */
  function guarded(): HumanInput {
    return HumanInput.read(undefined).interrupt(
      requested([approval("a")], { responsePolicyRequestIds: ["a"] }),
    ).humanInput;
  }

  function answerAs(responder: SessionAuthContext | null, optionId = "approve", now = NOW): Intake {
    return { now, responder, responses: [{ optionId, requestId: "a" }], type: "answered" };
  }

  function checks(events: readonly HumanInputEvent[]) {
    return events.flatMap((event) => (event.type === "responder.check" ? [event] : []));
  }

  function candidates(events: readonly HumanInputEvent[]) {
    return published(events, "approval.candidate").map((event) => ({
      outcome: event.data.outcome,
      reason: event.data.reason,
      responder: event.data.responderPrincipalId,
    }));
  }

  it("makes an answer a candidate for the policy to check, and holds the turn", () => {
    const { events, humanInput } = guarded().intake(answerAs(BOB));

    expect(candidates(events)).toEqual([
      { outcome: "pending", reason: undefined, responder: "bob" },
    ]);
    expect(checks(events)).toEqual([
      expect.objectContaining({
        at: AT,
        decision: "approve",
        request: approval("a"),
        requester: ALICE,
        responder: BOB,
      }),
    ]);
    expect(humanInput.next()).toEqual({ held: "input" });
    expect(published(events, "input.resolved")).toEqual([]);
  });

  it("never lets typed text answer a guarded approval", () => {
    const { events, humanInput } = guarded().intake({
      sender: ALICE,
      text: "approve",
      type: "message",
    });

    expect(events.some((event) => event.type === "message.answered")).toBe(false);
    expect(published(events, "input.resolved")[0]?.data.resolutions).toEqual([
      expect.objectContaining({ outcome: "ignored", requestId: "a" }),
    ]);
    expect(events.some((event) => event.type === "calls.approved")).toBe(false);
    expect(humanInput.next()).toEqual({ run: "model" });
  });

  it("settles the approval with the first allowed candidate and stales its competitors", () => {
    const answered = guarded().intake(answerAs(BOB)).humanInput.intake(answerAs(CAROL));
    const carolsCandidate = checks(answered.events)[0]!.candidateId;

    const { events, humanInput } = answered.humanInput.intake({
      candidateId: carolsCandidate,
      type: "responder.checked",
      verdict: "allowed",
    });

    expect(candidates(events)).toEqual([
      { outcome: "stale", reason: "Another response settled this approval.", responder: "bob" },
    ]);
    expect(published(events, "approval.settled")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          outcome: "approved",
          requestId: "a",
          responderPrincipalId: "carol",
        }),
      }),
    ]);
    expect(events).toContainEqual({ at: AT, requests: [approval("a")], type: "calls.approved" });
    expect(humanInput.next()).toEqual({ run: "model" });
    // Bob's verdict comes too late to change anything.
    const bobsCandidate = checks(guarded().intake(answerAs(BOB)).events)[0]!.candidateId;
    expect(
      humanInput.intake({
        candidateId: bobsCandidate,
        type: "responder.checked",
        verdict: "allowed",
      }).events,
    ).toEqual([]);
  });

  it("settles an allowed Cancel as denied, and the call never runs", () => {
    const answered = guarded().intake(answerAs(ALICE, "cancel"));

    const { events } = answered.humanInput.intake({
      candidateId: checks(answered.events)[0]!.candidateId,
      type: "responder.checked",
      verdict: "allowed",
    });

    expect(published(events, "approval.settled")[0]?.data.outcome).toBe("cancelled");
    expect(published(events, "input.resolved")[0]?.data.resolutions).toEqual([
      expect.objectContaining({ outcome: "denied", requestId: "a" }),
    ]);
    expect(events.some((event) => event.type === "calls.approved")).toBe(false);
  });

  it("keeps the approval open after a rejection, and a retry gets a fresh candidate", () => {
    const first = guarded().intake(answerAs(BOB));
    const firstId = checks(first.events)[0]!.candidateId;
    const rejected = first.humanInput.intake({
      candidateId: firstId,
      reason: "Wrong responder.",
      type: "responder.checked",
      verdict: "rejected",
    });

    expect(candidates(rejected.events)).toEqual([
      { outcome: "rejected", reason: "Wrong responder.", responder: "bob" },
    ]);
    expect(rejected.humanInput.next()).toEqual({ held: "input" });

    // The audit survives the session's state round trip, so the retry isn't the old candidate.
    const retry = HumanInput.read(rejected.humanInput.write(undefined)).intake(answerAs(BOB));
    const retryId = checks(retry.events)[0]?.candidateId;
    expect(retryId).toBeDefined();
    expect(retryId).not.toBe(firstId);
  });

  it("ignores a repeat of an active candidate and refuses an unsigned answer", () => {
    const answered = guarded().intake(answerAs(BOB)).humanInput;

    expect(answered.intake(answerAs(BOB)).events).toEqual([]);
    expect(checks(answered.intake(answerAs(BOB, "cancel")).events)).toHaveLength(1);
    expect(published(answered.intake(answerAs(null)).events, "message.completed")).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          message: "Authentication is required to respond to this approval.",
        }),
      }),
    ]);
  });

  it("fails a candidate whose policy failed, leaving the approval open", () => {
    const answered = guarded().intake(answerAs(BOB));
    const { events, humanInput } = answered.humanInput.intake({
      candidateId: checks(answered.events)[0]!.candidateId,
      type: "responder.checked",
      verdict: "failed",
    });

    expect(candidates(events)).toEqual([
      {
        outcome: "failed",
        reason: "We couldn’t verify your response. Please try again.",
        responder: "bob",
      },
    ]);
    expect(humanInput.next()).toEqual({ held: "input" });
  });

  it("holds on a responder's sign-in and checks the policy again once it completes", () => {
    const answered = guarded().intake(answerAs(BOB));
    const candidateId = checks(answered.events)[0]!.candidateId;
    const signIn = answered.humanInput.intake({
      candidateId,
      challenges: [challenge("r1", { name: "reviewer", principalId: "bob", requester: BOB })],
      type: "responder.checked",
      verdict: "authorization-required",
    });

    expect(published(signIn.events, "authorization.required")[0]?.data).toMatchObject({
      attemptId: "r1",
      candidateId,
      principalId: "bob",
    });
    expect(signIn.humanInput.awaitedSignIns()).toEqual(["r1"]);

    const { events } = signIn.humanInput.intake(callback("r1", "reviewer"));
    expect(outcomes(events)).toEqual([
      { attemptId: "r1", outcome: "authorized", reason: undefined },
    ]);
    // The responder's sign-in binds the responder itself, so the turn keeps its person.
    expect(events).toContainEqual(
      expect.objectContaining({ requester: null, type: "sign-in.completed" }),
    );
    expect(checks(events)).toEqual([expect.objectContaining({ candidateId, responder: BOB })]);
  });

  it("times a candidate out after ten minutes, failing its sign-in", () => {
    const answered = guarded().intake(answerAs(BOB));
    const candidateId = checks(answered.events)[0]!.candidateId;
    const signIn = answered.humanInput.intake({
      candidateId,
      challenges: [challenge("r1", { name: "reviewer" })],
      type: "responder.checked",
      verdict: "authorization-required",
    }).humanInput;

    expect(signIn.intake({ now: NOW + 10 * 60_000 - 1, type: "time" }).events).toEqual([]);
    const { events, humanInput } = signIn.intake({ now: NOW + 10 * 60_000, type: "time" });

    expect(candidates(events)).toEqual([
      { outcome: "timed-out", reason: undefined, responder: "bob" },
    ]);
    expect(outcomes(events)).toEqual([
      {
        attemptId: "r1",
        outcome: "failed",
        reason: "The approval response expired. Please submit a new response.",
      },
    ]);
    // The approval stays open for a new answer, and the late callback does nothing.
    expect(humanInput.openRequestIds()).toEqual(new Set(["a"]));
    expect(humanInput.intake(callback("r1", "reviewer")).events).toEqual([]);
  });

  it("stales active candidates and declines responder sign-ins when the turn moves on", () => {
    const answered = guarded().intake(answerAs(BOB));
    const candidateId = checks(answered.events)[0]!.candidateId;
    const signIn = answered.humanInput.intake({
      candidateId,
      challenges: [challenge("r1", { name: "reviewer" })],
      type: "responder.checked",
      verdict: "authorization-required",
    }).humanInput;

    for (const intake of [
      { sender: ALICE, text: "Never mind, just say hello.", type: "message" },
      { type: "cancelled" },
    ] satisfies Intake[]) {
      const { events, humanInput } = signIn.intake(intake);

      expect(candidates(events).map((candidate) => candidate.outcome)).toEqual(["stale"]);
      expect(outcomes(events).map((outcome) => outcome.outcome)).toEqual(["declined"]);
      // Only the turn's own sign-ins are named to the model.
      expect(events.some((event) => event.type === "note")).toBe(false);
      expect(humanInput.next()).toEqual({ run: "model" });
    }
  });
});
