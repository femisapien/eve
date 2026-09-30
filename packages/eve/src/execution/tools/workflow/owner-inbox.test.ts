import { describe, expect, it } from "vitest";

import {
  workflowToolRunFailureOutput,
  workflowToolRunAuthorizationPayload,
  workflowToolRunRequestToInputRequestPayload,
} from "#execution/tools/workflow/owner-inbox.js";

const from = {
  callId: "call-1",
  input: { message: "Find it" },
  runId: "run-1",
  sequence: 0,
  stepIndex: 0,
  toolName: "research",
  turnId: "turn-1",
};

describe("workflow-tool task input", () => {
  it("preserves a forwarded child request id independently of its session route", () => {
    const request = {
      action: {
        callId: "child-call",
        input: { ticker: "GOOG" },
        kind: "tool-call" as const,
        toolName: "get_stock_price",
      },
      kind: "tool-approval" as const,
      prompt: "Approve tool call: get_stock_price",
      requestId: "approval-1",
    };

    expect(
      workflowToolRunRequestToInputRequestPayload({
        from,
        replyTo: "subagent:parent:call-1",
        request,
      }),
    ).toMatchObject({
      childContinuationToken: "subagent:parent:call-1",
      event: {
        requests: [request],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      },
    });
  });

  it("keeps the producer identity when forwarding a child request", () => {
    const request = {
      action: { callId: "child-call", input: {}, kind: "tool-call" as const, toolName: "ask" },
      kind: "question" as const,
      prompt: "What is Alice's answer?",
      requestId: "alice-ask",
    };
    expect(
      workflowToolRunRequestToInputRequestPayload({
        from,
        inputSource: "child:alice",
        replyTo: "child-inbox",
        request,
      }),
    ).toMatchObject({ inputSource: "child:alice", event: { requests: [request] } });
  });

  it("presents a forwarded child request at the coordinates of the call its run serves", () => {
    const request = {
      action: {
        callId: "child-call",
        input: {},
        kind: "tool-call" as const,
        toolName: "approval_gate",
      },
      kind: "tool-approval" as const,
      prompt: "Approve?",
      requestId: "approval-2",
    };

    expect(
      workflowToolRunRequestToInputRequestPayload({
        from,
        replyTo: "subagent:parent:call-1",
        request,
      }),
    ).toMatchObject({
      childContinuationToken: "subagent:parent:call-1",
      event: {
        requests: [request],
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      },
    });
  });
});

describe("workflow-tool relayed sign-ins", () => {
  it("presents a child's sign-in at the coordinates of the call its run serves, which it names", () => {
    const payload = workflowToolRunAuthorizationPayload(
      { ...from, taskId: "research-1" },
      {
        callId: "child-call",
        childSessionId: "child-session",
        event: {
          data: {
            attemptId: "attempt_notes",
            description: "Sign in to notes.",
            name: "notes",
            sequence: 0,
            stepIndex: 3,
            turnId: "turn_0",
          },
          type: "authorization.required",
        },
        kind: "subagent-authorization-event",
        subagentName: "research",
      },
    );

    expect(payload.event.data).toMatchObject({
      callIds: [from.callId],
      sequence: 0,
      stepIndex: 0,
      taskId: "research-1",
      turnId: "turn-1",
    });
  });
});

describe("workflow-tool task outcomes", () => {
  it("keeps a structured workflow failure as task failure data", () => {
    expect(
      workflowToolRunFailureOutput({
        from,
        result: {
          error: {
            code: "SUBAGENT_EXECUTION_FAILED",
            message: "child crashed",
          },
          status: "failed",
        },
      }),
    ).toEqual({
      code: "SUBAGENT_EXECUTION_FAILED",
      message: "child crashed",
    });
  });

  it("keeps ordinary workflow-tool task failures as message strings", () => {
    expect(
      workflowToolRunFailureOutput({
        from,
        result: {
          error: {
            message: "export failed",
          },
          status: "failed",
        },
      }),
    ).toEqual("export failed");
  });
});
