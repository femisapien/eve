import { describe, expect, it } from "vitest";

import { projectInvocationInputRequest } from "#cli/invoke/result.js";
import type { InputRequest } from "#shared/input.js";

describe("projectInvocationInputRequest", () => {
  it("keeps who may answer a requester-only question", () => {
    const answerableBy = { authenticator: "slack", principalId: "U-bob", principalType: "user" };
    const request: InputRequest = {
      action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "release" },
      answerableBy,
      kind: "question",
      prompt: "Release api?",
      requestId: "ask-1",
    };

    expect(projectInvocationInputRequest(request)).toEqual({
      allowFreeform: undefined,
      answerableBy,
      kind: "question",
      options: undefined,
      prompt: "Release api?",
      requestId: "ask-1",
    });
  });
});
