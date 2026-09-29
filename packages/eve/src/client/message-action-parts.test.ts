import { describe, expect, it } from "vitest";

import { toMessageInputRequest } from "#client/message-action-parts.js";
import type { InputRequest } from "#shared/input.js";

describe("toMessageInputRequest", () => {
  it("keeps who may answer a requester-only question", () => {
    const answerableBy = { authenticator: "slack", principalId: "U-bob", principalType: "user" };
    const request: InputRequest = {
      action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "release" },
      answerableBy,
      kind: "question",
      prompt: "Release api?",
      requestId: "ask-1",
    };

    expect(toMessageInputRequest(request).answerableBy).toEqual(answerableBy);
  });
});
