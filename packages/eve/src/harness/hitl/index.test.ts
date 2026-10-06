import { reduceHumanInput, type Input } from "#harness/hitl/index.js";
import { describe, expect, it } from "vitest";

import {
  BOB,
  NOW,
  Turn,
  answer,
  approval,
  approvalsRequested,
  callback,
  cancel,
  challenge,
  waitingOnApprovals,
  message,
  overBudget,
  authorizationRequired,
} from "#internal/testing/hitl.js";

/** A step asks only once the model ran it: while the turn waits, it can't. */
function asks(turn: Turn, input: Input): Turn {
  const next = turn.next();
  return "run" in next && next.run === "model" ? turn.input(input) : turn;
}

/** What a person or the runtime can do to a turn, by name. */
const ACTIONS: Readonly<Record<string, (turn: Turn) => Turn>> = {
  "Alice's step asks to send_email and deploy": (turn) =>
    asks(turn, approvalsRequested([approval("send_email"), approval("deploy")])),
  "Alice approves send_email": (turn) => turn.input(answer("approve", "send_email")),
  "Alice cancels deploy": (turn) => turn.input(answer("cancel", "deploy")),
  "Alice types Approve": (turn) => turn.input(message("Approve")),
  "Alice types something else": (turn) => turn.input(message("Check the invoices first.")),
  "the turn is cancelled": (turn) => turn.input(cancel),
  "the session runs over budget": (turn) => turn.input(overBudget()),
  "Alice continues past the budget": (turn) => turn.input(answer("continue", "s:limit:input:12")),
  "Alice's call needs an authorization": (turn) =>
    turn.input(authorizationRequired([challenge("a1")])),
  "the authorization calls back": (turn) => turn.input(callback("a1")),
  "Alice's step asks for a guarded release": (turn) =>
    asks(
      turn,
      approvalsRequested([approval("release")], { responsePolicyRequestIds: ["release"] }),
    ),
  "Bob approves the release, and its policy allows him": (turn) =>
    turn.checked(answer("approve", "release", BOB), {
      kind: "returned",
      value: { status: "allowed" },
    }),
  "ten minutes pass": (turn) => turn.input({ now: NOW + 10 * 60_000, type: "time" }),
  "Bob's child asks to deploy": (turn) =>
    turn.input({
      at: { sequence: 4, stepIndex: 2, turnId: "child_turn_0" },
      requests: [approval("deploy", "child-deploy")],
      route: { childContinuationToken: "bob-token" },
      type: "relayed.requested",
    }),
  "Alice's answer for Bob's child arrives": (turn) =>
    turn.input({
      responses: [{ optionId: "approve", requestId: "child-deploy" }],
      type: "delivery.received",
    }),
};

/** Every sequence of up to `length` actions, by name. */
function sequences(length: number): string[][] {
  if (length === 0) return [[]];
  const shorter = sequences(length - 1);
  return [
    ...shorter,
    ...shorter
      .filter((sequence) => sequence.length === length - 1)
      .flatMap((sequence) => Object.keys(ACTIONS).map((name) => [...sequence, name])),
  ];
}

describe("HumanInput", () => {
  it("a turn with nothing open runs the model and leaves the rest of the session state alone", () => {
    const { humanInput } = Turn.idle();

    expect(humanInput.next()).toEqual({ run: "model" });
    expect(reduceHumanInput({ other: 1 }, { now: 0, type: "time" }).state).toEqual({ other: 1 });
  });

  it("the model never runs while a request of the turn's own is open", () => {
    const ranWhileOpen: string[] = [];
    for (const sequence of sequences(3)) {
      let turn = Turn.idle();
      for (const name of sequence) {
        turn = ACTIONS[name]!(turn).stored();
        const open =
          turn.humanInput.openRequestIds().size > 0 ||
          turn.humanInput.awaitedAuthorizations().length > 0;
        const next = turn.next();
        if (open && "run" in next && next.run === "model") ranWhileOpen.push(sequence.join(" → "));
      }
    }

    expect(ranWhileOpen).toEqual([]);
  });

  it("says how the turn's own person steers it", () => {
    // Waiting on them, their message steers past a queue turn policy.
    expect(waitingOnApprovals("deploy").humanInput.steering()).toEqual({
      interruptsGeneration: true,
      overridesQueue: true,
    });
    expect(Turn.idle().humanInput.steering()).toEqual({
      interruptsGeneration: true,
      overridesQueue: false,
    });
    // A relayed request is open: the message may answer it, so it waits for the boundary.
    const relayed = Turn.idle().input({
      at: { sequence: 1, stepIndex: 0, turnId: "child_turn" },
      requests: [approval("publish")],
      route: { childContinuationToken: "child_1" },
      type: "relayed.requested",
    });
    expect(relayed.humanInput.steering()).toEqual({
      interruptsGeneration: false,
      overridesQueue: false,
    });
  });

  it("an answer to a request that is no longer open becomes text that authorizes nothing", () => {
    const { humanInput } = waitingOnApprovals("deploy");

    const { displayMessage, input } = humanInput.acceptInput({
      inputResponses: [
        { optionId: "approve", requestId: "closed" },
        { optionId: "approve", requestId: "deploy" },
      ],
    });

    expect(input?.inputResponses).toEqual([{ optionId: "approve", requestId: "deploy" }]);
    expect(input?.message).toEqual(
      expect.stringContaining("This does not authorize an earlier action"),
    );
    expect(displayMessage).toBe("approve");
  });
  it("includes a new message immediately after a cancelled approval turn", () => {
    const { humanInput } = waitingOnApprovals("deploy").input(cancel).stored();
    expect(humanInput.next()).toEqual({ run: "model" });
    expect(humanInput.acceptInput({ message: "Answer this in the first step." })).toEqual({
      input: { message: "Answer this in the first step." },
    });
  });

  it("keeps approved work ahead of the next message, unlike a cancelled approval", () => {
    const { humanInput } = waitingOnApprovals("deploy").input(answer("approve", "deploy")).stored();
    expect(humanInput.next()).toEqual({ run: "approved" });
    expect(humanInput.approverOfRequest("deploy")?.principalId).toBe("alice");
  });

  it("a repeated press on an approval a person already settled is new input, not an answer", () => {
    // Alice approved deploy and the host ran it; her second press reaches the settled card.
    const { humanInput } = waitingOnApprovals("deploy").input(answer("approve", "deploy")).stored();

    const { displayMessage, input } = humanInput.acceptInput({
      inputResponses: [{ optionId: "approve", requestId: "deploy" }],
    });

    expect(input?.inputResponses).toBeUndefined();
    expect(input?.message).toEqual(
      expect.stringContaining("This does not authorize an earlier action"),
    );
    expect(displayMessage).toBe("approve");
  });
});
