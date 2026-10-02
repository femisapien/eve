import { describe, expect, it } from "vitest";

import { upsertRelayedInputRequests } from "#harness/open-input-requests.js";
import {
  answerSessionLimitRequest,
  openSessionLimitRequest,
  readSessionLimitRequest,
} from "#harness/session-limit-request.js";
import type { HarnessSession } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

const EVENT = { sequence: 0, stepIndex: 0, turnId: "turn_0" };

const LIMIT: InputRequest = {
  action: { callId: "limit", input: {}, kind: "tool-call", toolName: "session-limit" },
  kind: "session-limit",
  options: [
    { id: "continue", label: "Continue" },
    { id: "stop", label: "Stop" },
  ],
  prompt: "Alice's session is over budget. Continue?",
  requestId: "limit-1",
};

function overBudget(): HarnessSession {
  return openSessionLimitRequest(
    {
      agent: { modelReference: { id: "test-model" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "alice",
      history: [],
      sessionId: "alice-session",
    },
    { ...EVENT, request: LIMIT },
  );
}

describe("answerSessionLimitRequest", () => {
  it("takes a typed Continue when the budget question is the only open request", async () => {
    const answered = await answerSessionLimitRequest({
      session: overBudget(),
      stepInput: { message: "continue" },
    });

    expect(readSessionLimitRequest(answered.session)).toBeUndefined();
    expect(answered.stepInput?.message).toBeUndefined();
  });

  it("leaves a typed Continue for the turn while a relayed question is also open", async () => {
    const session = upsertRelayedInputRequests({
      entries: [["ask-1", { childContinuationToken: "child", event: EVENT, kind: "question" }]],
      forChildContinuationToken: "child",
      session: overBudget(),
    });
    const answered = await answerSessionLimitRequest({
      session,
      stepInput: { message: "continue" },
    });

    expect(readSessionLimitRequest(answered.session)?.request.requestId).toBe("limit-1");
    expect(answered.stepInput?.message).toBe("continue");
  });
});
