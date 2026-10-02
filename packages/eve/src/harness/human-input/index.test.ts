import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  HumanInput,
  type HumanInputEvent,
  type Intake,
  type Interrupt,
} from "#harness/human-input/index.js";
import type { InputRequest } from "#shared/input.js";

const AT = { sequence: 1, stepIndex: 0, turnId: "turn_1" };

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
  return { responder: null, responses: [{ optionId, requestId }], type: "answered" };
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

function published(events: readonly HumanInputEvent[], type: string) {
  return events.flatMap((event) =>
    event.type === "publish" && event.event.type === type ? [event.event] : [],
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

    it("fails the turn for an approval whose tool defines a response policy", () => {
      const { events, humanInput } = HumanInput.read(undefined).interrupt(
        requested([approval("a")], { responsePolicyRequestIds: ["a"] }),
      );

      expect(events).toEqual([
        expect.objectContaining({ code: "HUMAN_INPUT_UNAVAILABLE", type: "turn.failed" }),
      ]);
      expect(humanInput.next()).toEqual({ run: "model" });
    });

    it("keeps a partial answer and holds the turn until every approval of the step is answered", () => {
      const partial = waiting(approval("a"), approval("b")).intake({
        responder: ALICE,
        responses: [{ optionId: "approve", requestId: "a" }],
        type: "answered",
      });

      expect(partial.events).toEqual([]);
      expect(partial.humanInput.next()).toEqual({ held: "input" });

      const rest = HumanInput.read(partial.humanInput.write(undefined)).intake({
        responder: ALICE,
        responses: [{ optionId: "approve", requestId: "b" }],
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
