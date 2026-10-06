import { describe, expect, it } from "vitest";
import { createTestSessionState } from "#internal/testing/session-state.js";
import { isSessionStateIdleForHandoff } from "#execution/session/handoff-steps.js";

const run = {
  callId: "call",
  toolName: "research",
  origin: { turnId: "turn", stepIndex: 0 },
  address: { runId: "run", hookToken: "inbox" },
};

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
  it("parses workflow tool runs before checking for waiting work", () => {
    const incompatible = { ...run, address: { ...run.address, hookToken: 42 } };
    expect(() =>
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.workflowTool": { version: 4, runs: [incompatible] },
        }),
      ),
    ).toThrow("Corrupt workflow tool run registry");
  });
  it("does not skip run parsing when another registry is busy", () => {
    expect(() =>
      isSessionStateIdleForHandoff(
        checkpoint({
          "eve.runtime.pendingCoordinationBatch": {},
          "eve.workflowTool": {
            version: 4,
            runs: [{ ...run, address: { ...run.address, runId: null } }],
          },
        }),
      ),
    ).toThrow("Corrupt workflow tool run registry");
  });
  // Releases before HumanInput parked requests under these keys. This build
  // doesn't read them, so a session still carrying one must stay put.
  it.each([
    ["eve.runtime.pendingAuthorization", false],
    ["eve.runtime.pendingAuthorization", { challenges: [{ attemptId: "a", name: "github" }] }],
    ["eve.runtime.pendingInputBatch", {}],
    ["eve.runtime.pendingInputBatches", [null]],
    [
      "eve.runtime.pendingInputBatches",
      [{ requests: [{ kind: "tool-approval", requestId: "r" }], responseMessages: [] }],
    ],
    ["eve.runtime.pendingCoordinationBatch", {}],
    ["eve.runtime.deferredStepInput", {}],
    ["eve.harness.pendingWorkflowInterrupt", {}],
    ["eve.runtime.proxyInputRequests", { malformed: null }],
    ["eve.runtime.proxyInputRequests", "unreadable"],
  ])("refuses nonempty or unreadable pending work in %s", (key, value) => {
    expect(isSessionStateIdleForHandoff(checkpoint({ [key]: value }))).toBe(false);
  });
  it.each([
    ["eve.runtime.pendingInputBatches", []],
    ["eve.runtime.proxyInputRequests", {}],
  ])("accepts %s once nothing in it is open", (key, value) => {
    expect(isSessionStateIdleForHandoff(checkpoint({ [key]: value }))).toBe(true);
  });
});
