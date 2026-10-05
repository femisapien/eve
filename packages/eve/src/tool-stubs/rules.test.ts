import { describe, expect, it } from "vitest";

import { StubPlayback, parseToolStubs } from "#tool-stubs/rules.js";

describe("tool stubs", () => {
  it("rejects prototype keys instead of silently dropping a match constraint", () => {
    expect(() =>
      parseToolStubs(
        JSON.parse(
          '[{"id":"a","tool":"list","match":{"__proto__":{"const":"x"}},"response":null}]',
        ),
      ),
    ).toThrow(/prototype/i);
  });

  it("selects a response by partial input without changing the arguments", () => {
    const playback = new StubPlayback(
      parseToolStubs([
        {
          id: "milk",
          tool: "complete_task",
          match: { task_id: { const: "milk" } },
          response: { success: true },
        },
      ]),
    );
    const input = { task_id: "milk", reason: "Done" };

    expect(playback.call({ callId: "call-1", tool: "complete_task", input })).toEqual({
      kind: "stub",
      ruleId: "milk",
      position: 0,
      response: { success: true },
    });
    expect(input).toEqual({ task_id: "milk", reason: "Done" });
  });

  it("advances per call, repeats the last response, and reuses retried calls", () => {
    const playback = new StubPlayback(
      parseToolStubs([{ id: "tasks", tool: "list_tasks", responses: [["milk", "dog"], ["dog"]] }]),
    );
    const call = { tool: "list_tasks", input: {} };
    expect(playback.call({ ...call, callId: "first" })).toEqual({
      kind: "stub",
      ruleId: "tasks",
      position: 0,
      response: ["milk", "dog"],
    });
    expect(playback.call({ ...call, callId: "second" })).toEqual({
      kind: "stub",
      ruleId: "tasks",
      position: 1,
      response: ["dog"],
    });
    expect(playback.call({ ...call, callId: "first" })).toEqual({
      kind: "stub",
      ruleId: "tasks",
      position: 0,
      response: ["milk", "dog"],
    });
    expect(playback.call({ ...call, callId: "third" })).toEqual({
      kind: "stub",
      ruleId: "tasks",
      position: 1,
      response: ["dog"],
    });
  });

  it("requires each named field and matches nested shapes without filling defaults", () => {
    const playback = new StubPlayback(
      parseToolStubs([
        {
          id: "search",
          tool: "search",
          match: {
            filter: {
              type: "object",
              properties: { status: { const: "open", default: "open" } },
              required: ["status"],
            },
            query: { type: "string", pattern: "milk" },
            tags: { type: "array", contains: { const: "urgent" } },
          },
          response: ["milk"],
        },
      ]),
    );
    expect(playback.call({ callId: "missing", tool: "search", input: {} })).toEqual({
      kind: "real",
    });
    expect(
      playback.call({
        callId: "default",
        tool: "search",
        input: { filter: {}, query: "milk", tags: ["urgent"] },
      }),
    ).toEqual({ kind: "real" });
    expect(
      playback.call({
        callId: "match",
        tool: "search",
        input: {
          filter: { status: "open", owner: "alice" },
          query: "buy milk",
          tags: ["personal", "urgent"],
          limit: 10,
        },
      }),
    ).toEqual({ kind: "stub", ruleId: "search", position: 0, response: ["milk"] });
  });

  it("rejects ambiguous matches without using rule order", () => {
    const playback = new StubPlayback(
      parseToolStubs([
        { id: "first", tool: "list", response: [] },
        { id: "second", tool: "list", response: ["milk"] },
      ]),
    );
    expect(playback.call({ callId: "call", tool: "list", input: {} })).toEqual({
      kind: "error",
      error: 'Ambiguous tool stubs for "list": first, second.',
    });
  });

  it("rejects conditional replacement of persistent tools", () => {
    const playback = new StubPlayback(
      parseToolStubs([
        {
          id: "agent",
          tool: "tasks_agent",
          match: { message: { const: "hello" } },
          response: "hi",
        },
      ]),
    );
    expect(
      playback.call({
        callId: "call",
        tool: "tasks_agent",
        input: { message: "other" },
        persistent: true,
      }),
    ).toEqual({
      kind: "error",
      error: 'Persistent tool "tasks_agent" requires an unconditional stub.',
    });
  });

  it.each([
    [{ id: "a", tool: "list", responses: [] }],
    [{ id: "a", tool: "list", response: null, responses: [null] }],
    [
      { id: "a", tool: "list", response: null },
      { id: "a", tool: "list", response: null },
    ],
    [{ id: "a", tool: "list", match: { x: { type: "strng" } }, response: null }],
    [{ id: "a", tool: "list", match: { x: { pattern: "[" } }, response: null }],
    [{ id: "a", tool: "list", match: { x: { minimum: "1" } }, response: null }],
    [
      {
        id: "a",
        tool: "list",
        match: { x: { $ref: "https://example.com/schema" } },
        response: null,
      },
    ],
  ])("rejects invalid rules and unsupported schemas before execution: %j", (...rules) => {
    expect(() => parseToolStubs(rules)).toThrow();
  });
});

it("does not consume another rule's sequence or advance on unmatched calls", () => {
  const playback = new StubPlayback(
    parseToolStubs([
      {
        id: "open",
        tool: "lookup",
        match: { status: { const: "open" } },
        responses: ["open-1", "open-2"],
      },
      {
        id: "closed",
        tool: "lookup",
        match: { status: { const: "closed" } },
        responses: ["closed-1", "closed-2"],
      },
    ]),
  );
  const call = (callId: string, status: string) =>
    playback.call({ callId, tool: "lookup", input: { status } });
  expect(call("a", "open")).toMatchObject({ response: "open-1" });
  expect(call("b", "absent")).toEqual({ kind: "real" });
  expect(call("c", "closed")).toMatchObject({ response: "closed-1" });
  expect(call("d", "open")).toMatchObject({ response: "open-2" });
  expect(call("e", "closed")).toMatchObject({ response: "closed-2" });
});

it("requires the field even for a true constraint and fails overlapping partial matches", () => {
  const playback = new StubPlayback(
    parseToolStubs([
      { id: "present", tool: "lookup", match: { status: true }, response: "any" },
      { id: "open", tool: "lookup", match: { status: { const: "open" } }, response: "open" },
    ]),
  );
  expect(playback.call({ callId: "missing", tool: "lookup", input: {} })).toEqual({ kind: "real" });
  expect(playback.call({ callId: "null", tool: "lookup", input: { status: null } })).toMatchObject({
    response: "any",
  });
  expect(
    playback.call({ callId: "overlap", tool: "lookup", input: { status: "open" } }),
  ).toMatchObject({ kind: "error", error: expect.stringContaining("Ambiguous") });
});

it("includes the final visited string in the configuration size limit", () => {
  expect(() =>
    parseToolStubs([{ id: "x".repeat(1_000_001), tool: "list", response: null }]),
  ).toThrow(/size/);
});
