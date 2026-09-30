import { describe, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { readTurnState, writeTurnState, type ParkedCall } from "#harness/turn-state.js";
import type { InputRequest } from "#shared/input.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import {
  accumulateTurnUsage,
  getTurnUsageState,
  setTurnUsageState,
  takeSessionUsageDelta,
} from "#harness/turn-tag-state.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { runSessionStateStep } from "#internal/testing/session-state-step.js";

// The turn's stream events and channel context are not under test; the usage
// the step reports and the session it persists are.
vi.mock("#context/serialize.js", () => ({
  deserializeContext: vi.fn(async () => new ContextContainer()),
  serializeContext: () => ({}),
}));
const emitted = vi.hoisted((): UnstampedMessageStreamEvent[] => []);
vi.mock("#execution/publish-session-events.js", () => ({
  withSessionEventEmitter: async (
    input: { readonly durableSession: HarnessSession },
    emitEvents: (
      emit: (event: UnstampedMessageStreamEvent) => Promise<void>,
      session: HarnessSession,
    ) => Promise<{ readonly result: unknown; readonly session: HarnessSession }>,
    // Hydration of a session with no compaction history yields empty compaction state.
  ) =>
    await emitEvents(
      async (event) => {
        emitted.push(event);
      },
      { ...input.durableSession, compaction: {} } as HarnessSession,
    ),
}));

function spend<T extends { readonly state?: SessionStateMap }>(
  session: T,
  inputTokens: number,
  turnId: string,
): T {
  return setTurnUsageState(
    session,
    accumulateTurnUsage({
      previous: getTurnUsageState(session.state),
      turnId,
      usage: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens, outputTokens: 0 },
    }),
  );
}

function request(requestId: string, kind: InputRequest["kind"]): InputRequest {
  return {
    action: { callId: requestId, input: {}, kind: "tool-call", toolName: "deploy" },
    kind,
    prompt: "Continue?",
    requestId,
  };
}

function approval(requestId: string): ParkedCall {
  return {
    approval: { request: request(requestId, "tool-approval") },
    callId: requestId,
    input: {},
    status: "awaiting-approval",
    toolName: "deploy",
  };
}

describe("settleCancelledTurnStep", () => {
  it("withdraws what the cancel leaves unanswerable before the turn ends, and keeps the rest", async () => {
    const base = createTestSessionState({ sessionId: "deploy-session" });
    // An earlier turn parked Alice's staging approval. Her current turn waits
    // on a research run beside its production approval, and on a session-limit
    // prompt, when Bob cancels it.
    const parked = writeTurnState(base.snapshot.session, {
      ...readTurnState(undefined),
      prompt: {
        origin: { sequence: 1, stepIndex: 1, turnId: "turn_1" },
        request: request("limit-1", "session-limit"),
      },
      sequence: 1,
      started: true,
      steps: [
        {
          calls: [approval("approval-0")],
          origin: { sequence: 0, stepIndex: 0, turnId: "turn_0" },
          response: [],
        },
        {
          calls: [
            approval("approval-1"),
            { callId: "research-1", input: {}, status: "running", toolName: "research" },
          ],
          origin: { sequence: 1, stepIndex: 0, turnId: "turn_1" },
          response: [],
        },
      ],
      turn: { id: "turn_1", stepIndex: 1 },
    });
    emitted.length = 0;

    const result = await runSessionStateStep(
      {
        reportUsage: false,
        serializedContext: {},
        sessionState: { ...base, snapshot: { session: parked } },
        sessionWritable: new WritableStream<Uint8Array>(),
      },
      settleCancelledTurnStep,
    );

    // The calls the cancel stops settle first, then what it withdraws.
    expect(emitted.map((event) => event.type)).toEqual([
      "action.result",
      "action.result",
      "input.resolved",
      "input.resolved",
      "turn.cancelled",
      "session.waiting",
    ]);
    expect(
      emitted.flatMap((event) =>
        event.type === "action.result"
          ? [
              {
                callId: event.data.result.callId,
                code: event.data.error?.code,
                status: event.data.status,
              },
            ]
          : [],
      ),
    ).toEqual([
      { callId: "approval-1", code: "TURN_CANCELLED", status: "cancelled" },
      { callId: "research-1", code: "TURN_CANCELLED", status: "cancelled" },
    ]);
    expect(
      emitted.flatMap((event) => (event.type === "input.resolved" ? [event.data] : [])),
    ).toEqual([
      expect.objectContaining({
        resolutions: [{ kind: "tool-approval", outcome: "cancelled", requestId: "approval-1" }],
        turnId: "turn_1",
      }),
      expect.objectContaining({
        resolutions: [{ kind: "session-limit", outcome: "cancelled", requestId: "limit-1" }],
        turnId: "turn_1",
      }),
    ]);
    const turnState = readTurnState(readDurableSession(result.sessionState).state);
    expect(turnState.turn).toBeUndefined();
    expect(turnState.prompt).toBeUndefined();
    expect(turnState.steps.flatMap((step) => step.calls.map((call) => call.callId))).toEqual([
      "approval-0",
    ]);
  });

  it.each([
    { reportUsage: true, reported: 50, nextSettled: 0 },
    { reportUsage: false, reported: undefined, nextSettled: 50 },
  ])(
    "reports only what the session spent since its caller's last report (reports usage: $reportUsage)",
    async ({ reportUsage, reported, nextSettled }) => {
      const base = createTestSessionState({ sessionId: "reviewer-session" });
      // The reviewer's first turn spent 100 tokens and settled, reporting them.
      const settled = takeSessionUsageDelta(spend(base.snapshot.session, 100, "turn_1")).session;
      // Its next turn spent 50 more before Alice cancelled it.
      const cancelling = spend(settled, 50, "turn_2");

      const result = await runSessionStateStep(
        {
          reportUsage,
          serializedContext: {},
          sessionState: { ...base, snapshot: { session: cancelling } },
          sessionWritable: new WritableStream<Uint8Array>(),
        },
        settleCancelledTurnStep,
      );

      expect(result.usage?.inputTokens).toBe(reported);
      // The next settled turn reports whatever the cancel didn't.
      expect(takeSessionUsageDelta(readDurableSession(result.sessionState)).delta.inputTokens).toBe(
        nextSettled,
      );
    },
  );
});
