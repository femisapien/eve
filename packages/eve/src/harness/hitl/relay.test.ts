import { describe, expect, it } from "vitest";

import type { Input, RelayRoute, RequestAt } from "#harness/hitl/index.js";
import {
  BUDGET_QUESTION,
  Turn,
  approval,
  approvalsRequested,
  cancel,
} from "#internal/testing/hitl.js";
import {
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
} from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

/** Where Bob's child session asked, in its own turn. */
const CHILD_AT: RequestAt = { sequence: 4, stepIndex: 2, turnId: "child_turn_0" };
/** Bob's child session, run by workflow run `run-bob`. */
const BOB: RelayRoute = { childContinuationToken: "bob-token", runId: "run-bob" };

/** Bob's child asks where to deploy. */
function question(requestId: string, allowFreeform = false): InputRequest {
  return {
    action: { callId: `call-${requestId}`, input: {}, kind: "tool-call", toolName: "ask" },
    allowFreeform,
    kind: "question",
    options: [
      { id: "staging", label: "Staging" },
      { id: "production", label: "Production" },
    ],
    prompt: "Where should Bob deploy?",
    requestId,
  };
}

/** `from`'s turn relays `requests` that the child at `route` asked. */
function relayed(
  requests: readonly InputRequest[],
  {
    at = CHILD_AT,
    from = Turn.idle(),
    route = BOB,
  }: {
    at?: RequestAt;
    from?: Turn;
    route?: RelayRoute;
  } = {},
): Turn {
  return from.input({ at, requests, route, type: "relayed.requested" });
}

/** A delivery reaches the session carrying these answers, and maybe a message. */
function delivered(
  responses: readonly InputResponse[],
  message?: { readonly text: string; readonly delegated: boolean },
): Input {
  return { responses, type: "delivery.received", ...(message !== undefined && { message }) };
}

function forwarded(turn: Turn) {
  return turn.reported("forwardAnswer").map(({ responses, route }) => ({ responses, route }));
}

describe("relayed requests", () => {
  it("a relayed request is asked at the child's coordinates and the turn waits on it, not the model", () => {
    const turn = relayed([question("q")]);

    expect(turn.events).toEqual([
      {
        event: { data: { ...CHILD_AT, requests: [question("q")] }, type: "input.requested" },
        relayed: true,
        type: "publish",
      },
      { relayed: true, type: "waitTurn" },
    ]);
    expect(turn.next()).toEqual({ run: "model" });
    expect(turn.humanInput.openRequestIds()).toEqual(new Set());
    expect(turn.stored().humanInput.relayedRequestIds()).toEqual(new Set(["q"]));
  });

  it("a child's new batch from the same source replaces its earlier one, withdrawing what it left open", () => {
    const first = relayed([question("old")]);
    const other = relayed([question("other")], {
      from: first,
      route: { ...BOB, inputSource: "2" },
    });

    const turn = relayed([question("new")], { at: { ...CHILD_AT, sequence: 9 }, from: other });

    expect(turn.published("input.resolved").map(({ data }) => data)).toEqual([
      {
        ...CHILD_AT,
        resolutions: [{ kind: "question", outcome: "cancelled", requestId: "old" }],
      },
    ]);
    expect(turn.humanInput.relayedRequestIds()).toEqual(new Set(["other", "new"]));
  });

  it("answers go to whoever asked in the order given", () => {
    const asked = relayed([question("a"), question("b")]);

    const turn = asked.input(
      delivered([
        { optionId: "production", requestId: "b" },
        { optionId: "staging", requestId: "a" },
      ]),
    );

    expect(forwarded(turn)).toEqual([
      {
        responses: [
          { optionId: "production", requestId: "b" },
          { optionId: "staging", requestId: "a" },
        ],
        route: BOB,
      },
    ]);
  });

  it("each answer goes to whoever asked and resolves there; other answers stay with the turn", () => {
    const alice = { childContinuationToken: "alias", childSessionInbox: { sessionId: "alice" } };
    const bob = { childContinuationToken: "alias", childSessionInbox: { sessionId: "bob" } };
    const asked = relayed([question("b")], {
      from: relayed([question("a")], { route: alice }),
      route: bob,
    });

    const turn = asked.input(
      delivered([
        { optionId: "staging", requestId: "a" },
        { optionId: "production", requestId: "b" },
        { optionId: "approve", requestId: "own" },
      ]),
    );

    expect(forwarded(turn)).toEqual([
      { responses: [{ optionId: "staging", requestId: "a" }], route: alice },
      { responses: [{ optionId: "production", requestId: "b" }], route: bob },
    ]);
    expect(turn.resolutions()).toEqual([
      expect.objectContaining({ outcome: "answered", requestId: "a" }),
      expect.objectContaining({ outcome: "answered", requestId: "b" }),
    ]);
    expect(turn.storesNothing()).toBe(true);
  });

  it("the first answer to a relayed request wins, and a later one is not forwarded", () => {
    const turn = relayed([question("q")]).input(
      delivered([
        { optionId: "staging", requestId: "q" },
        { optionId: "production", requestId: "q" },
      ]),
    );

    expect(forwarded(turn)[0]?.responses).toEqual([{ optionId: "staging", requestId: "q" }]);
    expect(turn.input(delivered([{ optionId: "production", requestId: "q" }])).events).toEqual([]);
  });

  it("a batch without approvals closes at its first answer, the rest ignored", () => {
    const turn = relayed([question("q1"), question("q2")]).input(
      delivered([{ optionId: "staging", requestId: "q1" }]),
    );

    expect(turn.resolutions()).toEqual([
      expect.objectContaining({ outcome: "answered", requestId: "q1" }),
      { kind: "question", outcome: "ignored", requestId: "q2" },
    ]);
    expect(turn.humanInput.relayedRequestIds()).toEqual(new Set());
  });

  it("a batch with approvals closes once every approval is answered", () => {
    const partial = relayed([approval("a1"), approval("a2"), question("q")]).input(
      delivered([{ optionId: "approve", requestId: "a1" }]),
    );

    expect(partial.resolutions()).toEqual([
      expect.objectContaining({ outcome: "approved", requestId: "a1" }),
    ]);
    expect(partial.humanInput.relayedRequestIds()).toEqual(new Set(["a2", "q"]));

    const complete = partial.input(delivered([{ optionId: "cancel", requestId: "a2" }]));
    expect(complete.resolutions()).toEqual([
      expect.objectContaining({ outcome: "denied", requestId: "a2" }),
      { kind: "question", outcome: "ignored", requestId: "q" },
    ]);
    expect(complete.humanInput.relayedRequestIds()).toEqual(new Set());
  });

  it.each([
    { answers: true, name: "names an option of the only relayed question", text: "production" },
    {
      answers: true,
      name: "is free text the only relayed question allows",
      requests: [question("q", true)],
      text: "Use the canary pool",
    },
    { answers: false, name: "names no option", text: "Actually, check the logs first." },
    {
      answers: false,
      name: "could answer either of two relayed questions",
      requests: [question("q"), question("q2")],
      text: "production",
    },
    { answers: false, delegated: true, name: "comes from a delegating caller", text: "production" },
    {
      answers: false,
      explicit: [{ optionId: "staging", requestId: "q" }],
      name: "comes with explicit answers, which win",
      text: "production",
    },
  ])(
    "a typed reply that $name answers the relayed question: $answers",
    ({ answers, delegated = false, explicit = [], requests = [question("q")], text }) => {
      // Each question from its own child, beside an approval of the turn's own.
      let asked = Turn.idle().input(approvalsRequested([approval("own")]));
      for (const [index, request] of requests.entries()) {
        asked = relayed([request], { from: asked, route: { childContinuationToken: `c${index}` } });
      }

      const turn = asked.input(delivered(explicit, { delegated, text }));

      expect(turn.reported("consumeMessage")).toHaveLength(answers ? 1 : 0);
      if (answers) {
        expect(forwarded(turn)[0]?.responses).toEqual([
          text === "production"
            ? { optionId: "production", requestId: "q" }
            : { requestId: "q", text },
        ]);
      }
    },
  );

  it("a relayed budget question answered Stop cancels this turn too", () => {
    const turn = relayed([BUDGET_QUESTION]).input(
      delivered([{ optionId: "stop", requestId: BUDGET_QUESTION.requestId }]),
    );

    expect(forwarded(turn)).toHaveLength(1);
    expect(turn.events.at(-1)).toEqual({ type: "cancelTurn" });
  });

  it("an ended run's relayed requests are withdrawn, and a cancel withdraws the rest", () => {
    const alice = { childContinuationToken: "alice-token", runId: "run-alice" };
    const asked = relayed([question("b")], { from: relayed([question("a")], { route: alice }) });

    const ended = asked.input({ runId: "run-bob", type: "run.ended" });
    expect(ended.resolutions()).toEqual([
      { kind: "question", outcome: "cancelled", requestId: "b" },
    ]);
    expect(ended.humanInput.relayedRequestIds()).toEqual(new Set(["a"]));

    const cancelled = ended.input(cancel);
    expect(cancelled.resolutions()).toEqual([
      { kind: "question", outcome: "cancelled", requestId: "a" },
    ]);
    expect(cancelled.storesNothing()).toBe(true);
  });

  it("a run withdrawing its question is told so, and the question closes only if still open", () => {
    const asked = relayed([question("q")], { route: { ...BOB, control: "bob-control" } });
    const withdraw: Input = {
      control: "bob-control",
      requestId: "q",
      runId: "run-bob",
      type: "relayed.withdrawn",
    };
    const told = { control: "bob-control", requestId: "q", type: "withdrawQuestion" };

    const open = asked.input(withdraw);
    expect(open.reported("withdrawQuestion")).toEqual([told]);
    expect(open.resolutions()).toEqual([expect.objectContaining({ requestId: "q" })]);
    expect(open.humanInput.relayedRequestIds()).toEqual(new Set());

    const answered = asked.input(delivered([{ optionId: "staging", requestId: "q" }]));
    expect(answered.input(withdraw).events).toEqual([told]);
  });
});

describe("a child's authorization, relayed", () => {
  const required = createAuthorizationRequiredEvent({
    attemptId: "attempt-bob",
    description: "Sign in to github to continue.",
    name: "github",
    ...CHILD_AT,
  });
  const completed = createAuthorizationCompletedEvent({
    attemptId: "attempt-bob",
    name: "github",
    outcome: "authorized",
    ...CHILD_AT,
  });

  function signsIn(from = Turn.idle(), event: typeof required | typeof completed = required): Turn {
    return from.input({ event, runId: "run-bob", type: "relayed.authorization" });
  }

  it("publishes the child's authorization as relayed and records it, while the turn waits on the call that asked", () => {
    const turn = signsIn();

    expect(turn.reported("publish")).toEqual([{ event: required, relayed: true, type: "publish" }]);
    expect(turn.reported("waitTurn")).toHaveLength(1);
    expect(turn.next()).toEqual({ run: "model" });
    expect(turn.humanInput.openRequestIds().size).toBe(0);
    expect(turn.humanInput.awaitedAuthorizations()).toEqual([]);
    expect(turn.storesNothing()).toBe(false);
  });

  it("closes the authorization when the child reports it completed", () => {
    const turn = signsIn(signsIn().stored(), completed);

    expect(turn.reported("publish")).toEqual([
      { event: completed, relayed: true, type: "publish" },
    ]);
    expect(turn.reported("waitTurn")).toEqual([]);
    expect(turn.storesNothing()).toBe(true);
  });

  it("drops the authorization, reporting nothing, once the run that asked ends or the turn is cancelled", () => {
    const ended = signsIn().input({ runId: "run-bob", type: "run.ended" });
    const otherRunEnded = signsIn().input({ runId: "run-carol", type: "run.ended" });
    const cancelled = signsIn().input(cancel);

    expect(ended.storesNothing()).toBe(true);
    expect(ended.reported("publish")).toEqual([]);
    expect(otherRunEnded.storesNothing()).toBe(false);
    expect(cancelled.storesNothing()).toBe(true);
  });
});
