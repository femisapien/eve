import { describe, expect, it } from "vitest";

import {
  ALICE,
  AT,
  Turn,
  answer,
  answered,
  answers,
  approval,
  approvalsRequested,
  cancel,
  waitingOnApprovals,
  message,
  stepResponse,
} from "#internal/testing/hitl.js";

/** What Alice's call to `toolName` returned when it ran. */
function ran(toolName: string, value: { readonly [key: string]: boolean }) {
  return {
    output: { type: "json" as const, value },
    toolCallId: `call-${toolName}`,
    toolName,
    type: "tool-result" as const,
  };
}

/** What Alice's call to `toolName` returns when it never runs. */
function notRun(toolName: string, reason: string) {
  return {
    output: { reason, type: "execution-denied" },
    toolCallId: `call-${toolName}`,
    toolName,
    type: "tool-result",
  };
}

const deployTask = {
  callId: "call-deploy",
  entry: { entryPoint: "execute" as const },
  input: {},
  kind: "workflow-task" as const,
  toolName: "deploy",
  workflowId: "workflow//./agent/tools/deploy//execute",
};

describe("tool approvals", () => {
  it("asking publishes one request per call at the step's coordinates and the turn waits", () => {
    const turn = Turn.idle().input(
      approvalsRequested([approval("send_email"), approval("deploy")]),
    );

    expect(turn.published("input.requested")).toEqual([
      {
        data: { ...AT, requests: [approval("send_email"), approval("deploy")] },
        type: "input.requested",
      },
    ]);
    expect(turn.stored().next()).toEqual({ waiting: "input" });
    expect(turn.stored().humanInput.openRequestIds()).toEqual(new Set(["send_email", "deploy"]));
  });

  it("a partial answer settles its approval with the responder's name, keeps the turn waiting and runs nothing", () => {
    const turn = waitingOnApprovals("send_email", "deploy").input(answer("approve", "send_email"));

    // The channel retires the card naming Alice; the step's result waits for the other answer.
    expect(turn.events).toEqual([
      {
        event: {
          data: {
            ...AT,
            outcome: "approved",
            requestId: "send_email",
            responderPrincipalId: ALICE.principalId,
          },
          type: "approval.settled",
        },
        type: "publish",
      },
    ]);
    expect(turn.published("input.resolved")).toEqual([]);
    expect(turn.stored().next()).toEqual({ waiting: "input" });
  });

  it("each Approve or Cancel a signed-in person presses settles before the step's input.resolved", () => {
    const turn = waitingOnApprovals("send_email", "deploy").input(
      answered([
        { optionId: "approve", requestId: "send_email" },
        { optionId: "cancel", requestId: "deploy" },
      ]),
    );

    expect(
      turn.events.map((command) => ("event" in command ? command.event.type : command.type)),
    ).toEqual(["approval.settled", "approval.settled", "input.resolved", "action.result"]);
    expect(turn.published("approval.settled").map(({ data }) => data)).toEqual([
      {
        ...AT,
        outcome: "approved",
        requestId: "send_email",
        responderPrincipalId: ALICE.principalId,
      },
      { ...AT, outcome: "cancelled", requestId: "deploy", responderPrincipalId: ALICE.principalId },
    ]);
  });

  it("an answer nobody signed in for, or that picks no decision, settles nothing", () => {
    const anonymous = waitingOnApprovals("deploy").input(answer("approve", "deploy", null));
    expect(anonymous.published("approval.settled")).toEqual([]);
    expect(anonymous.resolutions().map(({ outcome }) => outcome)).toEqual(["approved"]);

    const invalid = waitingOnApprovals("deploy").input(answer("maybe", "deploy"));
    expect(invalid.published("approval.settled")).toEqual([]);
    expect(invalid.resolutions().map(({ outcome }) => outcome)).toEqual(["invalid"]);
  });

  it("the answer that completes the step runs the approved calls with the step that asked", () => {
    const turn = waitingOnApprovals("send_email", "deploy")
      .input(answer("approve", "send_email"))
      .stored()
      .input(answer("approve", "deploy"));
    expect(turn.resolutions().map(({ outcome, requestId }) => [requestId, outcome])).toEqual([
      ["send_email", "approved"],
      ["deploy", "approved"],
    ]);
    // The host runs them before the model runs again.
    expect(turn.stored().next()).toEqual({ run: "approved" });
    expect(turn.stored().approvedCalls()).toEqual({
      at: AT,
      requests: [approval("send_email"), approval("deploy")],
    });
    const done = turn
      .stored()
      .ranApproved([
        { content: [ran("send_email", { sent: true }), ran("deploy", { ok: true })], role: "tool" },
      ]);
    expect(done.approvedCalls()).toBeUndefined();
    expect(done.next()).toEqual({ run: "model" });
  });

  it("a denied or unrecognized answer records the call as not run, and only approved calls run", () => {
    const turn = waitingOnApprovals("send_email", "deploy", "delete_repo").input(
      answers({ send_email: "approve", deploy: "cancel", delete_repo: "maybe" }),
    );

    expect(turn.approvedCalls()).toEqual({ at: AT, requests: [approval("send_email")] });
    expect(turn.resolutions().map(({ outcome, requestId }) => [requestId, outcome])).toEqual([
      ["send_email", "approved"],
      ["deploy", "denied"],
      ["delete_repo", "invalid"],
    ]);
    // The step waits for the approved call's result before it joins history.
    expect(turn.appended()).toEqual([]);
    expect(turn.published("action.result").map((event) => event.data.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    const settled = turn
      .stored()

      .input({
        approved: {},
        results: [{ content: [ran("send_email", { sent: true })], role: "tool" }],
        type: "actions.settled",
      });
    expect(settled.appended()).toEqual([
      ...stepResponse([approval("send_email"), approval("deploy"), approval("delete_repo")]),
      {
        content: [
          notRun("deploy", "Tool execution was denied."),
          notRun("delete_repo", "Invalid approval response."),
          ran("send_email", { sent: true }),
        ],
        role: "tool",
      },
    ]);
    expect(settled.stored().humanInput.heldMessages()).toEqual([]);
  });

  it("a request id already open throws before anything is published, and the call it names still resolves", () => {
    const asked = waitingOnApprovals("deploy").stored();

    expect(() => asked.input(approvalsRequested([approval("send_email", "deploy")]))).toThrow(
      'Duplicate input request id: "deploy".',
    );
    expect(() =>
      Turn.idle().input(approvalsRequested([approval("deploy"), approval("send_email", "deploy")])),
    ).toThrow('Duplicate input request id: "deploy".');

    const turn = asked.input(answer("approve", "deploy"));
    expect(turn.approvedCalls()).toEqual({ at: AT, requests: [approval("deploy")] });
    const done = turn.ranApproved([{ content: [ran("deploy", { ok: true })], role: "tool" }]);
    expect(done.appended()).toEqual([
      ...stepResponse([approval("deploy")]),
      { content: [ran("deploy", { ok: true })], role: "tool" },
    ]);
  });

  it("a request id can be asked again once its approval resolved", () => {
    const first = waitingOnApprovals("deploy").input(answer("cancel", "deploy")).stored();

    const again = first.input(approvalsRequested([approval("deploy")]));
    expect(again.published("input.requested")).toHaveLength(1);
    expect(again.humanInput.openRequestIds()).toEqual(new Set(["deploy"]));
  });

  it("the last answer to a request wins", () => {
    const turn = waitingOnApprovals("deploy").input(
      answered([
        { optionId: "approve", requestId: "deploy" },
        { optionId: "cancel", requestId: "deploy" },
      ]),
    );

    expect(turn.next()).toEqual({ run: "model" });
    expect(turn.resolutions().map(({ outcome }) => outcome)).toEqual(["denied"]);
  });

  it("a typed reply that names an option answers the approvals, and the turn does not read it", () => {
    const turn = waitingOnApprovals("deploy").input(message("Approve"));

    expect(turn.events[0]).toEqual({ type: "consumeMessage" });
    expect(turn.next()).toEqual({ run: "approved" });
    expect(turn.approvedCalls()?.requests).toHaveLength(1);
  });

  it("any other message steers past unanswered approvals and keeps the answers already given", () => {
    const turn = waitingOnApprovals("send_email", "deploy")
      .input(answer("approve", "send_email"))
      .input(message("Never mind, check the draft status instead."));

    expect(turn.reported("consumeMessage")).toEqual([]);
    expect(turn.approvedCalls()).toEqual({ at: AT, requests: [approval("send_email")] });
    expect(turn.appended()).toEqual([]);
    expect(turn.next()).toEqual({ run: "approved" });
    expect(
      turn

        .input({
          approved: {},
          results: [{ content: [ran("send_email", { sent: true })], role: "tool" }],
          type: "actions.settled",
        })
        .appended(),
    ).toEqual([
      ...stepResponse([approval("send_email"), approval("deploy")]),
      {
        content: [
          notRun("deploy", "Ignored because the user continued without responding."),
          ran("send_email", { sent: true }),
        ],
        role: "tool",
      },
    ]);
  });

  it("a cancel resolves each open approval as cancelled at the step that asked", () => {
    const later = { sequence: 4, stepIndex: 2, turnId: "turn_1" };
    const turn = Turn.idle()
      .input(approvalsRequested([approval("deploy")], { at: later }))
      .input(cancel);

    expect(turn.published("input.resolved")).toEqual([
      {
        data: {
          ...later,
          resolutions: [{ kind: "tool-approval", outcome: "cancelled", requestId: "deploy" }],
        },
        type: "input.resolved",
      },
    ]);
    expect(turn.appended()).toEqual([
      ...stepResponse([approval("deploy")]),
      { content: [notRun("deploy", "Cancelled before anyone answered.")], role: "tool" },
    ]);
    expect(turn.storesNothing()).toBe(true);
  });

  it("asking keeps the step out of history until every call it made has a result", () => {
    const held = waitingOnApprovals("deploy").stored();

    expect(held.events.filter((event) => event.type === "appendHistory")).toEqual([]);
    expect(held.humanInput.heldMessages()).toEqual(stepResponse([approval("deploy")]));

    const denied = held.input(answer("cancel", "deploy"));
    expect(denied.appended()).toEqual([
      ...stepResponse([approval("deploy")]),
      { content: [notRun("deploy", "Tool execution was denied.")], role: "tool" },
    ]);
    // Only the audit remains: who cancelled.
    expect(denied.stored().humanInput.openRequestIds()).toEqual(new Set());
    expect(denied.stored().humanInput.heldMessages()).toEqual([]);
  });

  it("calls that ran beside open approvals wait with the step, and join history with it", () => {
    // The step also made a runtime call, so the coordination batch held its response.
    const step = [
      {
        content: [
          { input: {}, toolCallId: "call-deploy", toolName: "deploy", type: "tool-call" as const },
          { input: {}, toolCallId: "call-build", toolName: "build", type: "tool-call" as const },
        ],
        role: "assistant" as const,
      },
      { content: [ran("build", { built: true })], role: "tool" as const },
    ];
    const settled = Turn.idle()
      .input(approvalsRequested([approval("deploy")], { messages: [] }))
      .input({ results: step, type: "actions.settled" });

    expect(settled.appended()).toEqual([]);
    expect(settled.stored().next()).toEqual({ waiting: "input" });

    expect(settled.stored().input(answer("cancel", "deploy")).appended()).toEqual([
      step[0],
      {
        content: [ran("build", { built: true }), notRun("deploy", "Tool execution was denied.")],
        role: "tool",
      },
    ]);
  });

  it("an approved call that runs as runtime work keeps the step waiting for its result", () => {
    const approved = waitingOnApprovals("deploy").input(answer("approve", "deploy"));
    const dispatched = approved.stored().input({
      results: [],
      running: [deployTask],
      type: "actions.settled",
    });

    expect(dispatched.appended()).toEqual([]);
    expect(dispatched.stored().humanInput.heldMessages()).toEqual(
      stepResponse([approval("deploy")]),
    );
    expect(dispatched.stored().humanInput.runtimeCalls()?.calls).toEqual([
      { callId: "call-deploy", toolName: "deploy", waitsOn: "runtime" },
    ]);

    const settled = dispatched.stored().input({
      results: [{ content: [ran("deploy", { deployed: true })], role: "tool" }],
      type: "actions.settled",
    });
    expect(settled.appended()).toEqual([
      ...stepResponse([approval("deploy")]),
      { content: [ran("deploy", { deployed: true })], role: "tool" },
    ]);
    expect(settled.stored().humanInput.holdsStep()).toBe(false);
  });

  it("a cancel while a step waits answers every call it made", () => {
    const turn = Turn.idle()
      .input(
        approvalsRequested([approval("deploy")], {
          messages: [
            {
              content: [
                { input: {}, toolCallId: "call-deploy", toolName: "deploy", type: "tool-call" },
                { input: {}, toolCallId: "call-lookup", toolName: "lookup", type: "tool-call" },
              ],
              role: "assistant",
            },
          ],
        }),
      )
      .input(cancel);

    expect(turn.appended().at(-1)).toEqual({
      content: [
        notRun("deploy", "Cancelled before anyone answered."),
        notRun("lookup", "Cancelled before anyone answered."),
      ],
      role: "tool",
    });
  });

  it("results for a step parked with its calls already in history join history directly", () => {
    const results = [
      {
        content: [
          {
            output: { type: "json" as const, value: { sent: true } },
            toolCallId: "call-send_email",
            toolName: "send_email",
            type: "tool-result" as const,
          },
        ],
        role: "tool" as const,
      },
    ];

    expect(Turn.idle().input({ results, type: "actions.settled" }).appended()).toEqual(results);
  });

  it("an approved once() approval grants its key, except while another approval for it waits", () => {
    const keyed = (requestId: string) =>
      approvalsRequested([approval("deploy", requestId)], {
        approvalKeys: { [requestId]: "deploy:api" },
      });
    const granted = Turn.idle().input(keyed("first")).input(answer("approve", "first"));

    expect(granted.stored().humanInput.grantedApprovalKeys()).toEqual(new Set(["deploy:api"]));
    expect(granted.input(keyed("second")).humanInput.grantedApprovalKeys()).toEqual(new Set());
  });

  it("a session stored before human input keeps the tools it approved once, and only those", () => {
    const legacy = Turn.from({
      "eve.runtime.hitl.approvedTools": ["deploy:api", 7, "send_email"],
    });

    expect(legacy.humanInput.grantedApprovalKeys()).toEqual(new Set(["deploy:api", "send_email"]));
    expect(legacy.humanInput.openRequestIds()).toEqual(new Set());
    const asked = legacy
      .input(approvalsRequested([approval("deploy")], { approvalKeys: { deploy: "deploy:api" } }))
      .stored();
    expect(asked.state?.["eve.runtime.hitl.approvedTools"]).toBeUndefined();
    expect(asked.humanInput.grantedApprovalKeys()).toEqual(new Set(["send_email"]));
  });

  it("clearing the session's context keeps what it granted and what children relayed", () => {
    const granted = Turn.idle()
      .input(
        approvalsRequested([approval("deploy", "first")], {
          approvalKeys: { first: "deploy:api" },
        }),
      )
      .input(answer("approve", "first"))

      .input({
        approved: {},
        results: [{ content: [ran("deploy", {})], role: "tool" }],
        type: "actions.settled",
      })
      .input({
        at: AT,
        requests: [approval("publish", "child-publish")],
        route: { childContinuationToken: "child_1" },
        type: "relayed.requested",
      })
      .stored();
    expect(granted.humanInput.grantedApprovalKeys()).toEqual(new Set(["deploy:api"]));

    const cleared = granted.input({ type: "context.cleared" }).stored();

    expect(cleared.events).toEqual([]);
    expect(cleared.humanInput.grantedApprovalKeys()).toEqual(new Set(["deploy:api"]));
    expect(cleared.humanInput.relayedRequestIds()).toEqual(new Set(["child-publish"]));
    expect(cleared.next()).toEqual({ run: "model" });
  });
});
