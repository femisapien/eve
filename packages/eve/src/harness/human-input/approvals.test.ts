import { describe, expect, it } from "vitest";

import {
  AT,
  Turn,
  answer,
  answered,
  answers,
  approval,
  approvalsRequested,
  cancel,
  heldOnApprovals,
  message,
} from "#internal/testing/human-input.js";

/** What Alice's call to `toolName` returns when it never runs. */
function notRun(toolName: string, reason: string) {
  return {
    output: { reason, type: "execution-denied" },
    toolCallId: `call-${toolName}`,
    toolName,
    type: "tool-result",
  };
}

describe("tool approvals", () => {
  it("asking publishes one request per call at the step's coordinates and holds the turn", () => {
    const turn = Turn.idle().interrupt(
      approvalsRequested([approval("send_email"), approval("deploy")]),
    );

    expect(turn.published("input.requested")).toEqual([
      {
        data: { ...AT, requests: [approval("send_email"), approval("deploy")] },
        type: "input.requested",
      },
    ]);
    expect(turn.stored().next()).toEqual({ held: "input" });
    expect(turn.stored().humanInput.openRequestIds()).toEqual(new Set(["send_email", "deploy"]));
  });

  it("a partial answer keeps the turn held and runs nothing", () => {
    const turn = heldOnApprovals("send_email", "deploy").intake(answer("approve", "send_email"));

    expect(turn.events).toEqual([]);
    expect(turn.stored().next()).toEqual({ held: "input" });
  });

  it("the answer that completes the step runs the approved calls with the step that asked", () => {
    const turn = heldOnApprovals("send_email", "deploy")
      .intake(answer("approve", "send_email"))
      .stored()
      .intake(answer("approve", "deploy"));

    expect(turn.reported("calls.approved")).toEqual([
      { at: AT, requests: [approval("send_email"), approval("deploy")], type: "calls.approved" },
    ]);
    expect(turn.resolutions().map(({ outcome, requestId }) => [requestId, outcome])).toEqual([
      ["send_email", "approved"],
      ["deploy", "approved"],
    ]);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("a denied or unrecognized answer records the call as not run, and only approved calls run", () => {
    const turn = heldOnApprovals("send_email", "deploy", "delete_repo").intake(
      answers({ send_email: "approve", deploy: "cancel", delete_repo: "maybe" }),
    );

    expect(turn.reported("calls.approved")).toEqual([
      { at: AT, requests: [approval("send_email")], type: "calls.approved" },
    ]);
    expect(turn.resolutions().map(({ outcome, requestId }) => [requestId, outcome])).toEqual([
      ["send_email", "approved"],
      ["deploy", "denied"],
      ["delete_repo", "invalid"],
    ]);
    expect(turn.appended()).toEqual([
      {
        content: [
          notRun("deploy", "Tool execution was denied."),
          notRun("delete_repo", "Invalid approval response."),
        ],
        role: "tool",
      },
    ]);
    expect(turn.published("action.result").map((event) => event.data.status)).toEqual([
      "rejected",
      "rejected",
    ]);
  });

  it("the last answer to a request wins", () => {
    const turn = heldOnApprovals("deploy").intake(
      answered([
        { optionId: "approve", requestId: "deploy" },
        { optionId: "cancel", requestId: "deploy" },
      ]),
    );

    expect(turn.reported("calls.approved")).toEqual([]);
    expect(turn.resolutions().map(({ outcome }) => outcome)).toEqual(["denied"]);
  });

  it("a typed reply that names an option answers the approvals, and the turn does not read it", () => {
    const turn = heldOnApprovals("deploy").intake(message("Approve"));

    expect(turn.events[0]).toEqual({ type: "message.answered" });
    expect(turn.reported("calls.approved")).toHaveLength(1);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("any other message steers past unanswered approvals and keeps the answers already given", () => {
    const turn = heldOnApprovals("send_email", "deploy")
      .intake(answer("approve", "send_email"))
      .intake(message("Never mind, check the draft status instead."));

    expect(turn.reported("message.answered")).toEqual([]);
    expect(turn.reported("calls.approved")).toEqual([
      { at: AT, requests: [approval("send_email")], type: "calls.approved" },
    ]);
    expect(turn.appended()).toEqual([
      {
        content: [notRun("deploy", "Ignored because the user continued without responding.")],
        role: "tool",
      },
    ]);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("a cancel resolves each open approval as cancelled at the step that asked", () => {
    const later = { sequence: 4, stepIndex: 2, turnId: "turn_1" };
    const turn = Turn.idle()
      .interrupt(approvalsRequested([approval("deploy")], { at: later }))
      .intake(cancel);

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
      { content: [notRun("deploy", "Cancelled before anyone answered.")], role: "tool" },
    ]);
    expect(turn.storesNothing()).toBe(true);
  });

  it("the results of the calls the runtime ran join history", () => {
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

    expect(Turn.idle().intake({ results, type: "calls.settled" }).appended()).toEqual(results);
  });

  it("an approved once() approval grants its key, except while another approval for it waits", () => {
    const keyed = (requestId: string) =>
      approvalsRequested([approval("deploy", requestId)], {
        approvalKeys: { [requestId]: "deploy:api" },
      });
    const granted = Turn.idle().interrupt(keyed("first")).intake(answer("approve", "first"));

    expect(granted.stored().humanInput.grantedApprovalKeys()).toEqual(new Set(["deploy:api"]));
    expect(granted.interrupt(keyed("second")).humanInput.grantedApprovalKeys()).toEqual(new Set());
  });
});
