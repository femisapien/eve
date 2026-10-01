import { describe, expect, it, vi } from "vitest";
import { ContextContainer } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { stampTestEvent } from "#internal/testing/events.js";
import { createActionsRequestedEvent } from "#protocol/message.js";
import { createTurnEventHandler, isHookCancellableEvent } from "./turn-event-handler.js";

describe("isHookCancellableEvent", () => {
  it.each([
    "session.started",
    "turn.started",
    "step.started",
    "message.received",
    "actions.requested",
    "action.result",
    "authorization.required",
    "input.requested",
    "message.completed",
    "step.completed",
    "result.completed",
  ])("lets a %s hook cancel the running turn", (type) => {
    expect(isHookCancellableEvent(type)).toBe(true);
  });

  it.each([
    "step.failed",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
    "session.waiting",
    "session.completed",
    "session.failed",
    "context.cleared",
    "subagent.called",
    "subagent.completed",
    "subagent.event",
    "subagent.started",
    "internal.unlisted",
  ])("ignores cancellation from a %s hook", (type) => {
    expect(isHookCancellableEvent(type)).toBe(false);
  });
});

it("opens the owner's sandbox before dispatching a child that inherits it", async () => {
  const getSandbox = vi.fn(async () => null);
  const ctx = new ContextContainer();
  ctx.set(SandboxKey, {
    captureState: async () => ({ session: null }),
    get: getSandbox,
    stop: async () => {},
  });
  const childId = "child";
  const bundle = {
    graph: {
      nodesByNodeId: new Map([
        [childId, { sandboxRegistry: { sandbox: { definition: { kind: "parent" } } } }],
      ]),
    },
    subagentRegistry: {
      subagentsByName: new Map([["worker", { definition: { nodeId: childId } }]]),
    },
    resolvedAgent: { dynamicSkillResolvers: [], dynamicToolResolvers: [] },
  };
  const handle = createTurnEventHandler({
    abortSignal: new AbortController().signal,
    bundle: bundle as never,
    canCancelTurn: true,
    ctx,
    dynamicConnections: { dispatch: async () => {} } as never,
    effectiveAgent: { turnAgent: {} } as never,
    effectiveNode: { agent: { memories: [] } } as never,
    hookCancellation: new AbortController(),
    instrumentation: undefined,
    publisher: {
      dispatcher: { runHooks: async () => {} },
      emit: async (event: object) => stampTestEvent(event as never),
    } as never,
  });

  await handle(
    createActionsRequestedEvent({
      actions: [{ callId: "other", input: {}, kind: "tool-call", toolName: "other" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn",
    }),
    [],
  );
  expect(getSandbox).not.toHaveBeenCalled();

  await handle(
    createActionsRequestedEvent({
      actions: [{ callId: "call", input: {}, kind: "tool-call", toolName: "worker" }],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn",
    }),
    [],
  );

  expect(getSandbox).toHaveBeenCalledOnce();
});
