import { describe, expect, it } from "vitest";

import {
  readRelayedInputRequests,
  hasRelayedInputRequests,
  toRelayedInputRequests,
  upsertRelayedInputRequests,
} from "#harness/open-input-requests.js";
import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import type { InputRequest, InputRequestKind } from "#shared/input.js";
import type { HarnessSession } from "#harness/types.js";

const REQUEST_EVENT = { sequence: 0, stepIndex: 0, turnId: "turn_0" };

function createSession(state?: Record<string, unknown>): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
    state,
  };
}

function createRequest(requestId: string, kind: InputRequestKind): InputRequest {
  return {
    action: { callId: requestId, input: {}, kind: "tool-call", toolName: "test" },
    kind,
    prompt: "Respond",
    requestId,
  };
}

describe("upsertRelayedInputRequests", () => {
  it("records a fresh batch of proxy entries", () => {
    const session = createSession();
    const next = upsertRelayedInputRequests({
      entries: [
        ["req-1", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
      session,
    });

    expect(hasRelayedInputRequests(next.state)).toBe(true);
    expect(readRelayedInputRequests(next.state).get("req-1")).toEqual({
      childContinuationToken: "child-a",
      event: REQUEST_EVENT,
      kind: "question",
    });
  });

  it("replaces prior entries for the same child continuation token", () => {
    let session = upsertRelayedInputRequests({
      entries: [
        ["req-1", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    session = upsertRelayedInputRequests({
      entries: [
        ["req-2", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
      session,
    });

    const entries = readRelayedInputRequests(session.state);
    expect(entries.size).toBe(1);
    expect(entries.get("req-1")).toBeUndefined();
    expect(entries.get("req-2")).toEqual({
      childContinuationToken: "child-a",
      event: REQUEST_EVENT,
      kind: "question",
    });
  });

  it("keeps independent questions at the same answer destination", () => {
    let session = upsertRelayedInputRequests({
      entries: [
        [
          "alice",
          {
            childContinuationToken: "shared-inbox",
            inputSource: "workflow-alice",
            event: REQUEST_EVENT,
            kind: "question",
          },
        ],
      ],
      forChildContinuationToken: "shared-inbox",
      inputSource: "workflow-alice",
      session: createSession(),
    });
    session = upsertRelayedInputRequests({
      entries: [
        [
          "bob",
          {
            childContinuationToken: "shared-inbox",
            inputSource: "workflow-bob",
            event: REQUEST_EVENT,
            kind: "question",
          },
        ],
      ],
      forChildContinuationToken: "shared-inbox",
      inputSource: "workflow-bob",
      session,
    });

    expect([...readRelayedInputRequests(session.state).keys()]).toEqual(["alice", "bob"]);
  });

  it("preserves remote response coordinates through a durable proxy snapshot", () => {
    const remote = {
      name: "research",
      resolverId: "subagents/research.ts",
      sessionId: "remote-child-session",
      url: "https://remote.example.com",
    };
    const payload: SubagentInputRequestHookPayload = {
      callId: "call-1",
      childContinuationToken: "remote-reply",
      childSessionId: "remote-child-session",
      event: { requests: [createRequest("req-remote", "question")], ...REQUEST_EVENT },
      kind: "subagent-input-request",
      remote,
      subagentName: "research",
    };
    const session = upsertRelayedInputRequests({
      entries: toRelayedInputRequests(payload),
      forChildContinuationToken: payload.childContinuationToken,
      session: createSession(),
    });
    expect(
      readRelayedInputRequests(JSON.parse(JSON.stringify(session.state))).get("req-remote"),
    ).toMatchObject({
      remote,
      childContinuationToken: "remote-reply",
    });
  });

  it("drops a prior child's batch when its request ID is claimed by another child", () => {
    let session = upsertRelayedInputRequests({
      entries: [
        ["req-1", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
        ["req-2", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    session = upsertRelayedInputRequests({
      entries: [
        [
          "req-1",
          { childContinuationToken: "child-b", event: REQUEST_EVENT, kind: "tool-approval" },
        ],
      ],
      forChildContinuationToken: "child-b",
      session,
    });

    expect(Object.fromEntries(readRelayedInputRequests(session.state))).toEqual({
      "req-1": { childContinuationToken: "child-b", event: REQUEST_EVENT, kind: "tool-approval" },
      "req-2": { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" },
    });
  });

  it("keeps entries from other children when upserting", () => {
    let session = upsertRelayedInputRequests({
      entries: [
        ["req-a", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      ],
      forChildContinuationToken: "child-a",
      session: createSession(),
    });

    session = upsertRelayedInputRequests({
      entries: [
        [
          "req-b",
          { childContinuationToken: "child-b", event: REQUEST_EVENT, kind: "tool-approval" },
        ],
      ],
      forChildContinuationToken: "child-b",
      session,
    });

    const entries = readRelayedInputRequests(session.state);
    expect(entries.size).toBe(2);
    expect(entries.get("req-a")).toEqual({
      childContinuationToken: "child-a",
      event: REQUEST_EVENT,
      kind: "question",
    });
    expect(entries.get("req-b")).toEqual({
      childContinuationToken: "child-b",
      event: REQUEST_EVENT,
      kind: "tool-approval",
    });
  });
});

describe("toRelayedInputRequests", () => {
  it("persists the original child's inbox through a session snapshot round trip", () => {
    const childSessionInbox = { sessionId: "original-child", version: 1 };
    const entries = toRelayedInputRequests({
      callId: "call-1",
      childContinuationToken: "reusable-alias",
      childSessionId: "original-child",
      childSessionInbox,
      event: {
        requests: [createRequest("req-1", "question")],
        sequence: 0,
        stepIndex: 0,
        turnId: "t",
      },
      kind: "subagent-input-request",
      subagentName: "delegate",
    });
    const session = upsertRelayedInputRequests({
      entries,
      forChildContinuationToken: "reusable-alias",
      session: createSession(),
    });

    expect(
      readRelayedInputRequests(JSON.parse(JSON.stringify(session.state))).get("req-1"),
    ).toEqual(expect.objectContaining({ childSessionInbox }));
  });

  it("records shared batch and approval metadata on every route", () => {
    const requests = [
      createRequest("question-1", "question"),
      createRequest("approval-1", "tool-approval"),
    ];
    const payload = {
      callId: "call-1",
      childContinuationToken: "child-a",
      childSessionId: "child-session",
      event: { requests, sequence: 3, stepIndex: 2, turnId: "turn-1" },
      kind: "subagent-input-request",
      subagentName: "delegate",
    } satisfies SubagentInputRequestHookPayload;

    expect(toRelayedInputRequests(payload)).toEqual([
      [
        "question-1",
        {
          batch: {
            approvalRequestIds: ["approval-1"],
            requestIds: ["question-1", "approval-1"],
          },
          childContinuationToken: "child-a",
          event: { sequence: 3, stepIndex: 2, turnId: "turn-1" },
          kind: "question",
          question: {},
        },
      ],
      [
        "approval-1",
        {
          batch: {
            approvalRequestIds: ["approval-1"],
            requestIds: ["question-1", "approval-1"],
          },
          childContinuationToken: "child-a",
          event: { sequence: 3, stepIndex: 2, turnId: "turn-1" },
          kind: "tool-approval",
        },
      ],
    ]);
  });
});

describe("readRelayedInputRequests type safety", () => {
  it("returns an empty map when the session carries no proxy state", () => {
    const entries = readRelayedInputRequests(createSession().state);
    expect(entries.size).toBe(0);
  });

  it("ignores malformed values in the state map", () => {
    const session = createSession({
      "eve.runtime.openInputRequests": {
        "req-1": 42,
        "req-2": { childContinuationToken: 42, event: REQUEST_EVENT, kind: "question" },
        "req-3": { childContinuationToken: "child-c", kind: "other" },
        "req-4": { childContinuationToken: "child-d", event: REQUEST_EVENT, kind: "question" },
      },
    });
    const entries = readRelayedInputRequests(session.state);
    expect(entries.size).toBe(1);
    expect(entries.get("req-4")).toEqual({
      childContinuationToken: "child-d",
      event: REQUEST_EVENT,
      kind: "question",
    });
  });

  it("ignores a legacy array-shaped value", () => {
    const session = createSession({
      "eve.runtime.openInputRequests": [{ requestId: "req-1" }],
    });
    expect(readRelayedInputRequests(session.state).size).toBe(0);
  });

  it("keeps legacy routes and ignores malformed optional batch metadata", () => {
    const session = createSession({
      "eve.runtime.openInputRequests": {
        legacy: { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" },
        malformed: {
          batch: { approvalRequestIds: ["other"], requestIds: ["malformed"] },
          childContinuationToken: "child-a",
          event: REQUEST_EVENT,
          kind: "tool-approval",
        },
      },
    });

    expect([...readRelayedInputRequests(session.state)]).toEqual([
      ["legacy", { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "question" }],
      [
        "malformed",
        { childContinuationToken: "child-a", event: REQUEST_EVENT, kind: "tool-approval" },
      ],
    ]);
  });
});
