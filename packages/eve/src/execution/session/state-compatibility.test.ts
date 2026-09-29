import { describe, expect, it } from "vitest";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { isSessionStateIdleForHandoff } from "#execution/session/handoff-steps.js";

function checkpoint(state: Record<string, unknown>) {
  const value = createTestSessionState();
  return { ...value, snapshot: { session: { ...value.snapshot.session, state } } };
}

describe("handoff state inspection", () => {
  it("accepts additive framework metadata and opaque authored state", () => {
    expect(
      isSessionStateIdleForHandoff(
        checkpoint({
          authored: { version: "anything", values: [null, false] },
        }),
      ),
    ).toBe(true);
  });
  it("parses the turn state before checking for waiting work", () => {
    expect(() =>
      isSessionStateIdleForHandoff(checkpoint({ "eve.session": { version: 1, steps: "call" } })),
    ).toThrow("Unsupported session state");
  });
  it("does not skip turn state parsing when another registry is busy", () => {
    expect(() =>
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.runtime.pendingAuthorization": {},
          "eve.session": { version: 0, steps: [] },
        }),
      ),
    ).toThrow("Unsupported session state");
  });
  it.each([
    ["a parked step", { steps: [{ calls: [], origin: {}, response: [] }] }],
    ["a limit prompt", { prompt: { origin: {}, request: {} } }],
    ["queued input", { queued: { message: "Alice's follow-up" } }],
  ])("refuses a turn state holding %s", (_name, work) => {
    const turnState = { grants: [], sequence: 1, started: true, steps: [], version: 1, ...work };
    expect(isSessionStateIdleForHandoff(checkpoint({ "eve.session": turnState }))).toBe(false);
  });
  it.each([
    ["eve.runtime.pendingAuthorization", false],
    ["eve.harness.pendingWorkflowInterrupt", {}],
    ["eve.runtime.proxyInputRequests", { malformed: null }],
  ])("refuses nonempty or unreadable pending work in %s", (key, value) => {
    expect(isSessionStateIdleForHandoff(checkpoint({ [key]: value }))).toBe(false);
  });
});
