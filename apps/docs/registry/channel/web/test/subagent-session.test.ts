import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageStreamEvent } from "eve/client";
import { chatMessageReducer } from "../lib/chat-message-reducer.ts";
import {
  readSubagentEvents,
  subagentStreamPath,
  type SubagentSession,
} from "../lib/subagent-session.ts";

const child: SubagentSession = {
  sessionId: "parent",
  childSessionId: "child",
  callId: "call",
  childStreamPath: "/eve/v1/session/child/stream",
  name: "worker",
  toolName: "worker",
  turnId: "turn",
  sequence: 1,
  workflowId: "workflow",
};
const called: MessageStreamEvent = {
  type: "subagent.called",
  data: child,
  meta: { id: "called", at: "2026-09-20T12:00:00Z" },
};

test("child references survive replay and unrelated text deltas retain the same reference map", () => {
  const reducer = chatMessageReducer();
  const state = reducer.reduce(reducer.initial(), called);
  assert.equal(state.subagents.call.childSessionId, "child");
  const next = reducer.reduce(state, {
    type: "message.appended",
    data: { messageDelta: "hello", sequence: 1, stepIndex: 0, turnId: "turn" },
    meta: { id: "text", at: called.meta.at },
  });
  assert.equal(next.subagents, state.subagents);
  assert.equal(reducer.reduce(next, called).subagents.call.childSessionId, "child");
});
test("stream URLs bind local child reads to the parent and proxy remote sessions on the same origin", () => {
  assert.equal(
    subagentStreamPath(child, 7),
    "/eve/v1/session/child/stream?startIndex=7&includeTailIndex=1&parentSessionId=parent&callId=call",
  );
  assert.equal(
    subagentStreamPath({
      ...child,
      childStreamPath: "https://evil.example",
      remote: { url: "https://remote.example" },
    }),
    "/eve/v1/session/parent/subagents/call/child/stream?startIndex=0&includeTailIndex=1",
  );
});
test("stream reader handles split UTF-8, multiple lines, control records, and final unterminated records", async () => {
  const message = {
    type: "message.completed",
    data: { message: "hello 👋", turnId: "turn", sequence: 1, stepIndex: 0 },
    meta: { id: "text", at: called.meta.at },
  };
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(called)}\n${JSON.stringify({ $eve: "stream.lease-ended" })}\n${JSON.stringify(message)}`,
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readSubagentEvents(new Response(body), new AbortController().signal))
    events.push(event);
  assert.deepEqual(events, [called, message]);
});
test("disposing a subscription cancels an idle stream", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  const reader = readSubagentEvents(response, controller.signal);
  const next = reader.next();
  controller.abort();
  assert.equal((await next).done, true);
  assert.equal(cancelled, true);
});
test("stream HTTP and malformed record failures produce a recoverable error", async () => {
  for (const response of [new Response("", { status: 404 }), new Response("not json\n")]) {
    await assert.rejects(async () => {
      for await (const _event of readSubagentEvents(response, new AbortController().signal)) {
        /* Consume. */
      }
    });
  }
});
