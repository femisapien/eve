import { describe, expect, it } from "vitest";

import { emitTurnOpened } from "#harness/session-lifecycle.js";
import { openTurn, readTurnState } from "#harness/turn-state.js";
import type { HarnessEmitFn } from "#harness/types.js";

function collect(): { emit: HarnessEmitFn; events: Parameters<HarnessEmitFn>[0][] } {
  const events: Parameters<HarnessEmitFn>[0][] = [];
  return {
    emit: async (event) => {
      events.push(event);
    },
    events,
  };
}

describe("emitTurnOpened", () => {
  it("starts the session once and attaches one trace context to its start events", async () => {
    const { emit, events } = collect();
    const trace = {
      spanId: "0123456789abcdef",
      traceFlags: 1,
      traceId: "0123456789abcdef0123456789abcdef",
    };

    const turnState = await emitTurnOpened({
      emit,
      turnState: readTurnState(undefined),
      messages: [{ content: "hello", role: "user" }],
      stepInput: { message: "hello" },
      traceContext: trace,
    });

    expect(events.slice(0, 2)).toEqual([
      { data: { trace }, type: "session.started" },
      { data: { sequence: 0, trace, turnId: "turn_0" }, type: "turn.started" },
    ]);
    expect(events[2]).toMatchObject({ type: "message.received" });
    expect(turnState).toMatchObject({ started: true, turn: { id: "turn_0", stepIndex: 0 } });
  });

  it("re-enters an open turn with only the steering message", async () => {
    const { emit, events } = collect();
    const open = {
      ...openTurn(readTurnState(undefined)),
      turn: { id: "turn_0", stepIndex: 2 },
    };

    const turnState = await emitTurnOpened({
      emit,
      turnState: open,
      messages: [],
      stepInput: { message: "Use Fahrenheit." },
    });

    expect(events.map((event) => event.type)).toEqual(["message.received"]);
    expect(turnState).toBe(open);
  });
});
