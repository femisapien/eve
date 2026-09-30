import { describe, expect, it } from "vitest";

import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  checkSessionStream,
  type SessionContractRule,
} from "#internal/testing/session-contract.js";
import type { InputRequest } from "#shared/input.js";

const at = (turnId: string, stepIndex = 0) => ({
  sequence: Number(turnId.slice(5)),
  stepIndex,
  turnId,
});

function question(requestId: string): InputRequest {
  return {
    action: { callId: `${requestId}-call`, input: {}, kind: "tool-call", toolName: "deploy" },
    kind: "tool-approval",
    prompt: "Deploy Alice's release?",
    requestId,
  };
}

const started = (turnId: string): UnstampedMessageStreamEvent[] => [
  { data: { runtime: { agentId: "agent", eveVersion: "0" } }, type: "session.started" },
  { data: at(turnId), type: "turn.started" },
];
const ended = (turnId: string): UnstampedMessageStreamEvent[] => [
  { data: at(turnId), type: "turn.completed" },
  { data: { continuationToken: "c", wait: "next-user-message" }, type: "session.waiting" },
];
const asked = (
  requestId: string,
  turnId: string,
  taskId?: string,
): UnstampedMessageStreamEvent => ({
  data: { requests: [question(requestId)], ...at(turnId), ...(taskId && { taskId }) },
  type: "input.requested",
});
const resolved = (requestId: string, turnId: string): UnstampedMessageStreamEvent => ({
  data: {
    resolutions: [{ kind: "tool-approval", outcome: "cancelled", requestId }],
    ...at(turnId),
  },
  type: "input.resolved",
});
const approved = (resumeTurnId?: string): UnstampedMessageStreamEvent => ({
  data: {
    resolutions: [
      { kind: "tool-approval", outcome: "approved", requestId: "approval", resumeTurnId },
    ],
    ...at("turn_0"),
  },
  type: "input.resolved",
});
const taskStarted: UnstampedMessageStreamEvent = {
  data: {
    callId: "research",
    kind: "agent",
    name: "research",
    taskId: "research-1",
    turnId: "turn_0",
  },
  type: "task.started",
};
const taskSettled: UnstampedMessageStreamEvent = {
  data: { callId: "research", status: "cancelled", taskId: "research-1", turnId: "turn_0" },
  type: "task.settled",
};

describe("checkSessionStream", () => {
  it("accepts a session whose requests resolve before what owns them ends", () => {
    expect(
      checkSessionStream([
        ...started("turn_0"),
        taskStarted,
        asked("child-question", "turn_0", "research-1"),
        asked("approval", "turn_0"),
        ...ended("turn_0"),
        resolved("child-question", "turn_0"),
        taskSettled,
        { data: at("turn_1"), type: "turn.started" },
        resolved("approval", "turn_0"),
        { data: at("turn_1"), type: "turn.cancelled" },
        { data: { continuationToken: "c", wait: "next-user-message" }, type: "session.waiting" },
      ]),
    ).toEqual([]);
  });

  it.each<[string, SessionContractRule, UnstampedMessageStreamEvent[]]>([
    [
      "a request relayed at a child's own coordinates",
      "own-coordinates",
      [...started("turn_1"), asked("child-question", "turn_0", "research-1")],
    ],
    [
      "a task's request left open after the task settles",
      "open-after-owner",
      [
        ...started("turn_0"),
        taskStarted,
        asked("child-question", "turn_0", "research-1"),
        taskSettled,
        ...ended("turn_0"),
      ],
    ],
    [
      "an approval left open after its turn is cancelled",
      "open-after-owner",
      [
        ...started("turn_0"),
        asked("approval", "turn_0"),
        { data: at("turn_0"), type: "turn.cancelled" },
      ],
    ],
    [
      "an approval left open after the context is cleared",
      "open-after-owner",
      [
        ...started("turn_0"),
        asked("approval", "turn_0"),
        ...ended("turn_0"),
        { data: { sequence: 1, sessionId: "s", turnId: "turn_1" }, type: "context.cleared" },
      ],
    ],
    [
      "a turn that completes while its call has no outcome",
      "unsettled-call",
      [
        ...started("turn_0"),
        {
          data: {
            actions: [{ callId: "lookup", input: {}, kind: "tool-call", toolName: "lookup" }],
            ...at("turn_0"),
          },
          type: "actions.requested",
        },
        ...ended("turn_0"),
      ],
    ],
    [
      "a request resolved twice",
      "resolved-twice",
      [
        ...started("turn_0"),
        asked("approval", "turn_0"),
        resolved("approval", "turn_0"),
        resolved("approval", "turn_0"),
      ],
    ],
    [
      "a turn that starts while another is open",
      "turn-order",
      [...started("turn_0"), { data: at("turn_1"), type: "turn.started" }],
    ],
    [
      "a turn that continues a turn the stream never started",
      "own-coordinates",
      [
        ...started("turn_0"),
        ...ended("turn_0"),
        { data: { ...at("turn_2"), continuesTurnId: "turn_1" }, type: "turn.started" },
      ],
    ],
    [
      "an approval that names no turn to run its call",
      "turn-order",
      [...started("turn_0"), asked("approval", "turn_0"), ...ended("turn_0"), approved()],
    ],
    [
      "an approved call that runs in another turn than the one its approval named",
      "turn-order",
      [
        ...started("turn_0"),
        asked("approval", "turn_0"),
        ...ended("turn_0"),
        approved("turn_2"),
        { data: at("turn_1"), type: "turn.started" },
      ],
    ],
    [
      "a sign-in tied to a call the stream never announced",
      "own-coordinates",
      [
        ...started("turn_0"),
        {
          data: {
            attemptId: "attempt_github",
            callIds: ["lookup"],
            description: "Connect GitHub",
            name: "github",
            ...at("turn_0"),
          },
          type: "authorization.required",
        },
      ],
    ],
    [
      "a call settled for a sign-in the stream never asks for",
      "unasked-sign-in",
      [
        ...started("turn_0"),
        {
          data: {
            error: { code: "AUTHORIZATION_REQUIRED", message: "The call needs a sign-in." },
            result: { callId: "lookup", kind: "tool-result", output: null, toolName: "lookup" },
            status: "cancelled",
            ...at("turn_0"),
          },
          type: "action.result",
        },
        ...ended("turn_0"),
      ],
    ],
  ])("flags %s", (_name, rule, events) => {
    expect(checkSessionStream(events).map((violation) => violation.rule)).toContain(rule);
  });
});
