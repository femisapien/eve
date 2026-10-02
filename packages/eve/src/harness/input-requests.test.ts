import { jsonSchema, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { once } from "#tools/approval/policies.js";
import type { InputRequest } from "#shared/input.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  consumeQueuedInput,
  openApprovalRequestIds,
  hasStepInput,
  resolvePendingInput,
} from "#harness/input-requests.js";
import { getQueuedInput } from "#harness/open-approvals.js";
import { readTurnState } from "#harness/turn-state.js";
import { createRuntimeToolCallActionFromToolCall } from "#harness/tool-call-action.js";
import { buildToolApproval, buildToolSet } from "#harness/tools.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import { parkApprovals } from "#internal/testing/approval-fixtures.js";

function grants(session: HarnessSession): ReadonlySet<string> {
  return new Set(readTurnState(session.state).grants);
}

function createHarnessSession(): HarnessSession {
  return {
    agent: {
      modelReference: { modelId: "test", provider: "test" } as never,
      system: "",
      tools: [],
    },
    compaction: {
      recentWindowSize: 10,
      threshold: 0.8,
    },
    continuationToken: "test",
    history: [{ content: "previous", kind: "user", role: "user" }],
    sessionId: "sess-test",
  };
}

describe("hasStepInput", () => {
  it("returns false when input is undefined", () => {
    expect(hasStepInput(undefined)).toBe(false);
  });

  it("returns false when input has no message", () => {
    expect(hasStepInput({})).toBe(false);
  });

  it("returns true when input has a message", () => {
    expect(hasStepInput({ message: "hello" })).toBe(true);
  });
});

describe("createRuntimeToolCallActionFromToolCall", () => {
  it("creates a tool-call action from a typed tool call", () => {
    const result = createRuntimeToolCallActionFromToolCall({
      toolCall: {
        toolCallId: "call-123",
        toolName: "bash",
        input: { command: "ls -la" },
        type: "tool-call",
      } as never,
    });

    expect(result).toEqual({
      callId: "call-123",
      input: { command: "ls -la" },
      kind: "tool-call",
      toolName: "bash",
    });
  });

  it("defaults to empty object when input is undefined", () => {
    const result = createRuntimeToolCallActionFromToolCall({
      toolCall: {
        toolCallId: "call-456",
        toolName: "read_file",
        input: undefined,
        type: "tool-call",
      } as never,
    });

    expect(result.input).toEqual({});
  });

  it("omits undefined properties from tool call input objects", () => {
    const result = createRuntimeToolCallActionFromToolCall({
      toolCall: {
        toolCallId: "call-789",
        toolName: "read_file",
        input: {
          path: "/workspace/foo.txt",
          startLine: undefined,
        },
        type: "tool-call",
      } as never,
    });

    expect(result.input).toEqual({
      path: "/workspace/foo.txt",
    });
  });

  it("includes the tool name when tool call input is not a JSON object", () => {
    expect(() =>
      createRuntimeToolCallActionFromToolCall({
        toolCall: {
          toolCallId: "call-123",
          toolName: "bash",
          input: [],
          type: "tool-call",
        } as never,
      }),
    ).toThrow(
      'Failed to parse tool-call arguments for "bash" (call-123): Expected a JSON-serializable object.',
    );
  });
});

describe("resolvePendingInput", () => {
  it("keeps turn input delivered with every answer in the step that reads the answers", () => {
    const session = parkApprovals({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "pwd" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [
        {
          content: [
            {
              input: { command: "pwd" },
              toolCallId: "approval-call",
              toolName: "bash",
              type: "tool-call",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: {
        context: ["<linear_context>issue metadata</linear_context>"],
        inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
        message: "Then say hi.",
      },
      session,
    });

    // eve runs the approved call before the model reads the message, so
    // nothing waits for a later step.
    expect(result.outcome).toBe("resolved");
    expect(result.deferredMessage).toBeUndefined();
    expect(result.deferredContext).toBeUndefined();
    expect(getQueuedInput(result.session)).toBeUndefined();
  });

  it("queues responses for requests the step does not hold", () => {
    const approval = (requestId: string): InputRequest => ({
      action: { callId: `${requestId}-call`, input: {}, kind: "tool-call", toolName: "bash" },
      kind: "tool-approval",
      prompt: "Approve tool call: bash",
      requestId,
    });
    const session = parkApprovals({
      requests: [approval("approval-1")],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      session,
      stepInput: {
        inputResponses: [
          { optionId: "approve", requestId: "approval-1" },
          { optionId: "approve", requestId: "approval-2" },
        ],
      },
    });

    expect(result.outcome).toBe("resolved");
    expect(getQueuedInput(result.session)).toEqual({
      inputResponses: [{ optionId: "approve", requestId: "approval-2" }],
    });
  });

  it("resolves approval when follow-up text matches an option", () => {
    const session = parkApprovals({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "pwd" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [
        {
          content: [
            {
              input: { command: "pwd" },
              toolCallId: "approval-call",
              toolName: "bash",
              type: "tool-call",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: { message: "approve" },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.deferredMessage).toBeUndefined();
    expect(result.consumedMessage).toBe(true);
    // The approved call waits in its step, without a result, for eve to run it.
    expect(readTurnState(result.session.state).suspended[0]).toMatchObject({ requests: [] });
    expect(readTurnState(result.session.state).suspended[0]?.messages.at(-1)?.role).toBe(
      "assistant",
    );
    expect(result.messages).toEqual(session.history);
    expect(grants(result.session).has("bash")).toBe(true);
    expect(getQueuedInput(result.session)).toBeUndefined();
  });

  it("records compound approval key when resolveApprovalKey is provided", () => {
    const session = parkApprovals({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { teamId: "team_abc", limit: 10 },
            kind: "tool-call",
            toolName: "vercel__list_projects",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: vercel__list_projects",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [
        {
          content: [
            {
              input: { teamId: "team_abc", limit: 10 },
              toolCallId: "approval-call",
              toolName: "vercel__list_projects",
              type: "tool-call",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      approvalKey: (request) => {
        const team = request.action.input?.teamId;
        return typeof team === "string" ? `${request.action.toolName}:${team}` : undefined;
      },
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    const approved = grants(result.session);
    expect(approved.has("vercel__list_projects:team_abc")).toBe(true);
    expect(approved.has("vercel__list_projects")).toBe(false);
  });

  it("answers a denied call with an execution-denied result after the call", () => {
    const session = parkApprovals({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "pwd" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [
        {
          content: [
            {
              input: { command: "pwd" },
              toolCallId: "approval-call",
              toolName: "bash",
              type: "tool-call",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "cancel" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(readTurnState(result.session.state).suspended[0]?.messages.at(-1)).toEqual({
      content: [
        {
          output: { type: "execution-denied", reason: "Tool execution was denied." },
          toolCallId: "approval-call",
          toolName: "bash",
          type: "tool-result",
        },
      ],
      role: "tool",
    });
  });

  it("returns a rejected action for an ACP denial", () => {
    const session = parkApprovals({
      event: { sequence: 5, stepIndex: 1, turnId: "turn_0" },
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "pwd" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "deny" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.rejectedActions).toEqual([
      {
        event: { sequence: 5, stepIndex: 1, turnId: "turn_0" },
        results: [
          {
            callId: "approval-call",
            isError: true,
            kind: "tool-result",
            output: {
              approval: {
                requestId: "approval-1",
                status: "denied",
              },
              code: "TOOL_EXECUTION_DENIED",
              message: "Tool execution was denied.",
              tool: {
                result: "not_run",
              },
            },
            toolName: "bash",
          },
        ],
      },
    ]);
    expect(result.resolvedInputs).toMatchObject([
      {
        event: { sequence: 5, stepIndex: 1, turnId: "turn_0" },
        inputs: [
          {
            outcome: "denied",
            request: { requestId: "approval-1" },
            response: { optionId: "deny", requestId: "approval-1" },
          },
        ],
      },
    ]);
  });

  it("does not return a rejected action when an approval is granted", () => {
    const session = parkApprovals({
      event: { sequence: 5, stepIndex: 1, turnId: "turn_0" },
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "pwd" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(result.rejectedActions).toBeUndefined();
    expect(result.resolvedInputs).toMatchObject([
      {
        event: { sequence: 5, stepIndex: 1, turnId: "turn_0" },
        inputs: [
          {
            outcome: "approved",
            request: { requestId: "approval-1" },
            response: { optionId: "approve", requestId: "approval-1" },
          },
        ],
      },
    ]);
  });

  it("does not retain approval when a deferred response is superseded", () => {
    const approval = (requestId: string, callId: string): InputRequest => ({
      action: { callId, input: { command: "pwd" }, kind: "tool-call", toolName: "bash" },
      allowFreeform: false,
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Yes" },
        { id: "cancel", label: "No" },
      ],
      prompt: "Approve tool call: bash",
      requestId,
    });
    const session = parkApprovals({
      event: { sequence: 5, stepIndex: 1, turnId: "turn_0" },
      requests: [approval("approval-1", "call-1"), approval("approval-2", "call-2")],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const partial = resolvePendingInput({
      session,
      stepInput: { inputResponses: [{ requestId: "approval-1", optionId: "approve" }] },
    });
    const deferred = consumeQueuedInput({
      input: {
        inputResponses: [
          { requestId: "approval-1", optionId: "cancel" },
          { requestId: "approval-2", optionId: "approve" },
        ],
      },
      session: partial.session,
    });
    const result = resolvePendingInput({
      approvalKey: (request) => request.requestId,
      session: deferred.session,
      stepInput: deferred.input,
    });

    expect(grants(result.session)).toEqual(new Set(["approval-2"]));
    expect(result.rejectedActions?.[0]?.results).toEqual([
      expect.objectContaining({
        callId: "call-1",
      }),
    ]);
  });

  it("steers past a pending approval when a follow-up message arrives instead of an answer", () => {
    const session = parkApprovals({
      event: { sequence: 7, stepIndex: 2, turnId: "turn_1" },
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "pwd" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: { message: "Never mind, do something else." },
      session,
    });

    // The message moves the turn on: the call never runs, and the model reads
    // the message in the same step.
    expect(result.outcome).toBe("resolved");
    expect(result.resolvedInputs).toMatchObject([
      { inputs: [{ outcome: "ignored", request: { requestId: "approval-1" } }] },
    ]);
    expect(result.rejectedActions?.[0]?.results).toMatchObject([{ callId: "approval-call" }]);
    expect(getQueuedInput(result.session)).toBeUndefined();
    expect(openApprovalRequestIds(result.session.state)).toEqual(new Set());
  });

  it("preserves context-only input while a pending batch stays open", () => {
    const session = parkApprovals({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "pwd" },
            kind: "tool-call",
            toolName: "bash",
          },
          kind: "tool-approval",
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        },
      ],
      responseMessages: [],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      session,
      stepInput: { context: ["channel context"] },
    });
    const deferred = consumeQueuedInput({ session: result.session });

    expect(result.outcome).toBe("unresolved");
    expect(deferred.input).toEqual({ context: ["channel context"] });
  });

  it("falls back to tool name when no approvalKey is provided", () => {
    const session = parkApprovals({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: { command: "rm -rf /tmp" },
            kind: "tool-call",
            toolName: "bash",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: bash",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [
        {
          content: [
            {
              input: { command: "rm -rf /tmp" },
              toolCallId: "approval-call",
              toolName: "bash",
              type: "tool-call",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");
    expect(grants(result.session).has("bash")).toBe(true);
  });

  it("approval survives the authorization park so an auth+approval tool is not approved twice", () => {
    // A tool requiring both approval and auth is approved first, then its
    // execute parks for sign-in. On resume the step re-runs and the toolset
    // is rebuilt from the persisted approvedTools. The recorded approval must
    // survive on session.state across the park, so approval returns
    // "not-applicable" and the user is never asked to approve a second time.
    // See research/per-tool-auth-known-issues.md, issue 3.
    const session = parkApprovals({
      requests: [
        {
          action: {
            callId: "approval-call",
            input: {},
            kind: "tool-call",
            toolName: "linear_whoami",
          },
          allowFreeform: false,
          display: "confirmation",
          kind: "tool-approval",
          options: [
            { id: "approve", label: "Yes" },
            { id: "cancel", label: "No" },
          ],
          prompt: "Approve tool call: linear_whoami",
          requestId: "approval-1",
        } satisfies InputRequest,
      ],
      responseMessages: [
        {
          content: [
            {
              input: {},
              toolCallId: "approval-call",
              toolName: "linear_whoami",
              type: "tool-call",
            },
          ],
          role: "assistant",
        } satisfies ModelMessage,
      ],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({
      stepInput: {
        inputResponses: [{ requestId: "approval-1", optionId: "approve" }],
      },
      session,
    });

    expect(result.outcome).toBe("resolved");

    // The resume-after-sign-in step rebuilds the toolset from the persisted
    // approvals. once() must not re-request approval for the now-approved tool.
    const tools: HarnessToolMap = new Map<string, HarnessToolDefinition>([
      [
        "linear_whoami",
        {
          description: "Resolve the caller's Linear identity.",
          execute: async () => ({ ok: true }),
          inputSchema: jsonSchema({ type: "object" }),
          name: "linear_whoami",
          approval: once(),
        },
      ],
    ]);

    const rebuilt = buildToolSet({
      approvedTools: grants(result.session),
      tools,
    });
    const approval = buildToolApproval(rebuilt);
    if (typeof approval !== "function") throw new TypeError("Expected generic approval function.");

    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "sess-test",
      turn: { id: "turn-test", sequence: 0 },
    });

    return expect(
      contextStorage.run(ctx, () =>
        approval({
          messages: [],
          runtimeContext: {},
          toolCall: {
            input: {},
            toolCallId: "call-1",
            toolName: "linear_whoami",
          } as never,
          tools: rebuilt,
          toolsContext: {} as never,
        }),
      ),
    ).resolves.toBe("not-applicable");
  });
});

describe("pending input batch collection", () => {
  function approvalRequest(requestId: string, callId: string): InputRequest {
    return {
      action: { callId, input: { command: "pwd" }, kind: "tool-call", toolName: "bash" },
      allowFreeform: false,
      display: "confirmation",
      kind: "tool-approval",
      options: [
        { id: "approve", label: "Yes" },
        { id: "cancel", label: "No" },
      ],
      prompt: "Approve tool call: bash",
      requestId,
    };
  }

  function batchOutput(callId: string, toolName: string): ModelMessage {
    return {
      content: [{ input: {}, toolCallId: callId, toolName, type: "tool-call" }],
      role: "assistant",
    };
  }

  it("holds on a pending approval when the step brings no answer or message", () => {
    const session = parkApprovals({
      event: { sequence: 5, stepIndex: 1, turnId: "turn_1" },
      requests: [approvalRequest("approval-1", "call-1")],
      responseMessages: [batchOutput("call-1", "bash")],
      session: createHarnessSession(),
    });

    const result = resolvePendingInput({ session });

    expect(result.outcome).toBe("unresolved");
    expect(openApprovalRequestIds(result.session.state)).toEqual(new Set(["approval-1"]));
  });
});
