import { describe, expect, it, vi } from "vitest";

import {
  ask,
  attachWorkflowToolRunContext,
  WorkflowToolRunAsks,
} from "#execution/tools/workflow/ask.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import type { ToolContext } from "#tools/definition.js";

vi.mock("#execution/tools/workflow/resume-hook-step.js", () => ({ resumeHookStep: vi.fn() }));

describe("ask", () => {
  it("resolves as unavailable without waiting when the session cannot request input", async () => {
    const ctx = {} as ToolContext;
    attachWorkflowToolRunContext(ctx, {
      asks: new WorkflowToolRunAsks("run"),
      canRequestInput: false,
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
      owner: { inbox: "inbox" },
    });

    await expect(ask(ctx, { prompt: "Which region?" })).resolves.toEqual({
      status: "unavailable",
    });
    expect(resumeHookStep).not.toHaveBeenCalled();
  });
});
