import { describe, expect, it, vi } from "vitest";
import * as sandboxAccess from "#execution/sandbox/ensure.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { BashJobsKey } from "#execution/sandbox/bash-jobs.js";
import { setLogRecordSubscriber, type LogRecord } from "#internal/logging.js";

import type { SessionStateMap } from "#harness/types.js";
import { readDurableSession } from "#execution/durable-session-store.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import {
  getProxyInputRequests,
  upsertProxyInputRequestState,
  type ProxyInputRequest,
} from "#harness/proxy-input-requests.js";
import { filterEventsByType } from "#internal/testing/events.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import {
  accumulateTurnUsage,
  getTurnUsageState,
  setTurnUsageState,
  takeSessionUsageDelta,
} from "#harness/turn-tag-state.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { runSessionStateStep } from "#internal/testing/session-state-step.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const serializedContext = {
  "eve.auth": null,
  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
  "eve.channel": { kind: "http", state: {} },
  "eve.continuationToken": "test-token",
  "eve.sessionId": "test-session",
};

/**
 * Runs the step in a real runtime, so it publishes through the session's real
 * publication path. Returns the step's result and the events it wrote.
 */
async function settleCancelledTurn(
  input: Omit<Parameters<typeof settleCancelledTurnStep>[0], "sessionWritable">,
) {
  const events: MessageStreamEvent[] = [];
  const decoder = new TextDecoder();
  const sessionWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      events.push(JSON.parse(decoder.decode(chunk)) as MessageStreamEvent);
    },
  });
  const runtime = await createTestRuntime({ agent: { name: "settle-cancelled-turn" } });
  const result = await runtime.run(() =>
    runSessionStateStep({ ...input, sessionWritable }, settleCancelledTurnStep),
  );
  return { ...result, events };
}

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

describe("settleCancelledTurnStep", () => {
  it.each(["unavailable", "run-rejected", "nonzero"])(
    "settles cancellation and preserves jobs when sandbox cleanup is %s",
    async (failure) => {
      const logs: LogRecord[] = [];
      const sandbox = mockSandbox({
        run: async () => {
          if (failure === "run-rejected") throw new Error("sandbox transport unavailable");
          return { exitCode: 1, stdout: "", stderr: "stop failed" };
        },
      });
      const access = vi.spyOn(sandboxAccess, "ensureSandboxAccess").mockResolvedValue({
        ...sandbox.access,
        get: async () => {
          if (failure === "unavailable") throw new Error("sandbox resume failed");
          return sandbox.session;
        },
      });
      const jobs = [
        {
          turnId: "turn_1",
          pid: 123,
          outputDirectory: "/tmp/.eve/jobs/owned",
          identity: "boot:123",
        },
      ];
      setLogRecordSubscriber((record) => logs.push(record));
      try {
        const result = await settleCancelledTurn({
          history: [],
          reportUsage: false,
          serializedContext: { ...serializedContext, [BashJobsKey.name]: jobs },
          sessionState: (() => {
            const base = createTestSessionState();
            const state = { sequence: 1, sessionStarted: true, stepIndex: 1, turnId: "turn_1" };
            return {
              ...base,
              emissionState: state,
              snapshot: {
                session: { ...base.snapshot.session, state: { "eve.harness.emission": state } },
              },
            };
          })(),
        });
        expect(result.events.map((event) => event.type)).toEqual([
          "turn.cancelled",
          "session.waiting",
        ]);
        expect(result.sessionState.emissionState.turnId).toBe("");
        expect(result.serializedContext[BashJobsKey.name]).toEqual(jobs);
        expect(logs).toContainEqual(
          expect.objectContaining({
            level: "warn",
            fields: expect.objectContaining({ turnId: "turn_1" }),
          }),
        );
      } finally {
        access.mockRestore();
        setLogRecordSubscriber(undefined);
      }
    },
  );
  it("stops jobs from the first interrupted turn before its preamble was checkpointed", async () => {
    const sandbox = mockSandbox();
    const access = vi.spyOn(sandboxAccess, "ensureSandboxAccess").mockResolvedValue(sandbox.access);
    try {
      const result = await settleCancelledTurn({
        history: [],
        reportUsage: false,
        serializedContext: {
          ...serializedContext,
          [BashJobsKey.name]: [
            {
              turnId: "turn_0",
              pid: 123,
              outputDirectory: "/tmp/.eve/jobs/owned",
              identity: "boot:123",
            },
          ],
        },
        sessionState: createTestSessionState(),
      });
      expect(sandbox.commandLog).toHaveLength(1);
      expect(result.serializedContext[BashJobsKey.name]).toEqual([]);
      expect(result.events.map((event) => event.type)).toEqual([
        "turn.cancelled",
        "session.waiting",
      ]);
    } finally {
      access.mockRestore();
    }
  });

  it.each([
    { reportUsage: true, reported: 50, nextSettled: 0 },
    { reportUsage: false, reported: undefined, nextSettled: 50 },
  ])(
    "reports only what the session spent since its caller's last report (reports usage: $reportUsage)",
    async ({ reportUsage, reported, nextSettled }) => {
      const base = createTestSessionState({
        emissionState: { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn_2" },
        sessionId: "reviewer-session",
      });
      // The reviewer's first turn spent 100 tokens and settled, reporting them.
      const settled = takeSessionUsageDelta(spend(base.snapshot.session, 100, "turn_1")).session;
      // Its next turn spent 50 more before Alice cancelled it.
      const cancelling = spend(settled, 50, "turn_2");

      const result = await settleCancelledTurn({
        history: [],
        reportUsage,
        serializedContext,
        sessionState: { ...base, snapshot: { session: cancelling } },
      });

      expect(result.usage?.inputTokens).toBe(reported);
      // The next settled turn reports whatever the cancel didn't.
      expect(takeSessionUsageDelta(readDurableSession(result.sessionState)).delta.inputTokens).toBe(
        nextSettled,
      );
    },
  );

  it("withdraws every request the session relays before it reports the turn cancelled", async () => {
    const base = createTestSessionState({
      emissionState: { sequence: 3, sessionStarted: true, stepIndex: 1, turnId: "turn_1" },
      sessionId: "support-session",
    });
    // Alice's turn relays a question from Bob's deploy task and an approval
    // from the reviewer subagent when she cancels it.
    const state = relay(
      relay(base.snapshot.session.state, "deploy-run-ask-1", {
        kind: "question",
        runId: "deploy-run",
        workflowAsk: { control: "deploy-run-control", question: {} },
      }),
      "reviewer-approval-1",
      { kind: "tool-approval" },
    );

    const result = await settleCancelledTurn({
      history: [],
      reportUsage: false,
      serializedContext,
      sessionState: { ...base, snapshot: { session: { ...base.snapshot.session, state } } },
    });

    expect(result.events.map((event) => event.type)).toEqual([
      "input.resolved",
      "input.resolved",
      "turn.cancelled",
      "session.waiting",
    ]);
    expect(
      filterEventsByType(result.events, "input.resolved").map((event) => event.data.resolutions),
    ).toEqual([
      [{ kind: "question", outcome: "cancelled", requestId: "deploy-run-ask-1" }],
      [{ kind: "tool-approval", outcome: "cancelled", requestId: "reviewer-approval-1" }],
    ]);
    expect(getProxyInputRequests(readDurableSession(result.sessionState).state).size).toBe(0);
  });
});

function relay(
  state: SessionStateMap | undefined,
  requestId: string,
  route: Pick<ProxyInputRequest, "kind" | "runId" | "workflowAsk">,
): SessionStateMap | undefined {
  return upsertProxyInputRequestState({
    entries: [
      [
        requestId,
        {
          ...route,
          childContinuationToken: requestId,
          event: { sequence: 2, stepIndex: 0, turnId: "turn_1" },
        },
      ],
    ],
    forChildContinuationToken: requestId,
    state,
  });
}
