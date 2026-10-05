import { expect, it } from "vitest";

import { replaceDurableSessionSnapshot } from "#execution/durable-session-store.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { withdrawRelayedRequests } from "#harness/human-input/effects/workflow.js";
import { HumanInput, reduceHumanInput } from "#harness/human-input/index.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { createAuthorizationRequiredEvent, type MessageStreamEvent } from "#protocol/message.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

const serializedContext = {
  "eve.auth": null,
  "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
  "eve.channel": { kind: "http", state: {} },
  "eve.continuationToken": "test-token",
  "eve.sessionId": "test-session",
};

/** A session whose only relayed exchange is a sign-in `run-1`'s child started. */
function signingInThroughRun() {
  const base = createTestSessionState();
  const { state } = reduceHumanInput(base.snapshot.session.state, {
    event: createAuthorizationRequiredEvent({
      attemptId: "attempt-1",
      description: "Sign in to github to continue.",
      name: "github",
      sequence: 1,
      stepIndex: 0,
      turnId: "child_turn_0",
    }),
    runId: "run-1",
    type: "relayed.authorization",
  });
  return replaceDurableSessionSnapshot({
    session: { ...base.snapshot.session, state },
    state: base,
  });
}

it("ends the sign-in a run started when that run ends, though it relayed no request", async () => {
  const runtime = await createTestRuntime({ agent: { name: "withdraw-relayed-sign-in" } });
  const streamed: MessageStreamEvent[] = [];
  const sessionWritable = new WritableStream<Uint8Array>({
    write(chunk) {
      streamed.push(JSON.parse(new TextDecoder().decode(chunk)) as MessageStreamEvent);
    },
  });
  const cursor = new SessionStateCursor({
    history: [],
    inbox: { claimSessionHooks: async () => {} },
    serializedContext,
    sessionState: signingInThroughRun(),
    sessionWritable,
  });
  const humanInput = () => HumanInput.read(cursor.sessionState.snapshot.session.state);
  expect(humanInput().relayedRequestIds().size).toBe(0);
  expect(humanInput().relaysAnything()).toBe(true);

  await runtime.run(async () => {
    await withdrawRelayedRequests(cursor, { runId: "run-1", type: "run.ended" });
  });

  expect(humanInput().relaysAnything()).toBe(false);
  // The child reports its own sign-in's completion, so ending it publishes nothing.
  expect(streamed).toEqual([]);
});
