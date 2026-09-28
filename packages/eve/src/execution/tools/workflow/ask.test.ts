import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  ask,
  attachWorkflowToolRunContext,
  WorkflowToolRunAsks,
} from "#execution/tools/workflow/ask.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import type { WorkflowToolRunInbox } from "#execution/tools/workflow/owner.js";
import type { ToolContext } from "#tools/definition.js";

function askContext(input: {
  readonly abortSignal?: AbortSignal;
  readonly current?: SessionAuthContext | null;
  readonly requestInput: boolean;
  readonly send: WorkflowToolRunInbox["send"];
}) {
  const ctx = { abortSignal: input.abortSignal ?? new AbortController().signal } as ToolContext;
  const asks = new WorkflowToolRunAsks("run");
  attachWorkflowToolRunContext(ctx, {
    agentContext: { capabilities: { requestInput: input.requestInput } } as AgentSessionContext,
    asks,
    auth: { current: input.current ?? null, initiator: null },
    control: "control",
    from: {
      callId: "call",
      input: {},
      runId: "run",
      sequence: 1,
      stepIndex: 0,
      toolName: "ask_question",
      turnId: "turn",
    },
    owner: { send: input.send, sent: 0 },
  });
  return { asks, ctx };
}

describe("ask", () => {
  it("resolves as unavailable without waiting when the session cannot request input", async () => {
    const send = vi.fn<WorkflowToolRunInbox["send"]>();
    const { ctx } = askContext({ requestInput: false, send });

    await expect(ask(ctx, { prompt: "Which region?" })).resolves.toEqual({
      status: "unavailable",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("removes its abort listeners once answered", async () => {
    const call = new AbortController();
    const caller = new AbortController();
    const { asks, ctx } = askContext({
      abortSignal: call.signal,
      requestInput: true,
      send: vi.fn<WorkflowToolRunInbox["send"]>(async () => {}),
    });

    const answer = ask(ctx, { prompt: "Which region?" }, { signal: caller.signal });
    asks.settle({
      kind: "answer",
      requestId: "run-ask-1",
      response: { status: "answered", text: "us-east-1" },
    });
    await expect(answer).resolves.toEqual({ status: "answered", text: "us-east-1" });

    expect(getEventListeners(call.signal, "abort")).toHaveLength(0);
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
  });

  it("resolves a requester-only question as unavailable when no one requested the call", async () => {
    const send = vi.fn<WorkflowToolRunInbox["send"]>();
    const { ctx } = askContext({ requestInput: true, send });

    await expect(
      ask(ctx, { prompt: "Which region?" }, { answerableBy: "requester" }),
    ).resolves.toEqual({ status: "unavailable" });
    expect(send).not.toHaveBeenCalled();
  });

  it("names the call's requester as the only one who may answer", () => {
    const send = vi.fn<WorkflowToolRunInbox["send"]>(() => new Promise<never>(() => {}));
    const bob: SessionAuthContext = {
      attributes: { team: "T1" },
      authenticator: "slack",
      principalId: "U-bob",
      principalType: "user",
    };
    const { ctx } = askContext({ current: bob, requestInput: true, send });

    void ask(ctx, { prompt: "Which region?" }, { answerableBy: "requester" });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          answerableBy: { authenticator: "slack", principalId: "U-bob", principalType: "user" },
        }),
      }),
    );
  });
});
