import { HumanInput } from "#harness/hitl/index.js";
import { readState } from "#harness/hitl/state-legacy.js";
import { store } from "#harness/hitl/state.js";
import { describe, expect, it } from "vitest";

describe("HumanInput.unreadableKeys", () => {
  it("names nothing for a session without human input", () => {
    expect(HumanInput.unreadableKeys(undefined)).toEqual([]);
    expect(HumanInput.unreadableKeys({ authored: { open: true } })).toEqual([]);
  });

  it("names its own key when it doesn't parse, since read sees nothing open", () => {
    for (const value of [42, null, { requests: "unreadable", grants: [] }, { requests: {} }]) {
      const state = { "eve.harness.humanInput": value };
      expect(HumanInput.unreadableKeys(state)).toEqual(["eve.harness.humanInput"]);
      expect(HumanInput.read(state).next()).toEqual({ run: "model" });
    }
  });

  it("names nothing for its own key once nothing in it is open", () => {
    const state = { "eve.harness.humanInput": { requests: {}, grants: ["deploy"] } };
    expect(HumanInput.unreadableKeys(state)).toEqual([]);
  });

  it("names every key a release before HumanInput parked a request under", () => {
    const state = {
      "eve.runtime.pendingInputBatches": [
        { requests: [{ kind: "tool-approval", requestId: "r" }], responseMessages: [] },
      ],
      "eve.runtime.pendingInputBatch": {},
      "eve.runtime.pendingAuthorization": { challenges: [] },
      "eve.runtime.proxyInputRequests": { r: { childContinuationToken: "child" } },
      "eve.runtime.deferredStepInput": { message: "later" },
      "eve.harness.pendingWorkflowInterrupt": {},
    };
    expect([...HumanInput.unreadableKeys(state)].sort()).toEqual(Object.keys(state).sort());
  });

  it("skips the empty collections those releases left once nothing was open", () => {
    const state = {
      "eve.runtime.pendingInputBatches": [],
      "eve.runtime.proxyInputRequests": {},
    };
    expect(HumanInput.unreadableKeys(state)).toEqual([]);
  });

  it("clears every key those releases parked under once a commit stores this build's state", () => {
    const ownState = readState({ "eve.harness.humanInput": { requests: {}, grants: ["deploy"] } });
    const state = {
      authored: { open: true },
      "eve.harness.humanInput": ownState,
      "eve.runtime.pendingInputBatches": [
        { requests: [{ kind: "tool-approval", requestId: "r" }], responseMessages: [] },
      ],
      "eve.runtime.pendingInputBatch": {},
      "eve.runtime.pendingAuthorization": { challenges: [] },
      "eve.runtime.proxyInputRequests": { r: { childContinuationToken: "child" } },
      "eve.runtime.deferredStepInput": { message: "later" },
      "eve.harness.pendingWorkflowInterrupt": {},
    };
    const stored = store(state, readState(state));
    expect(stored).toEqual({ authored: { open: true }, "eve.harness.humanInput": ownState });
    expect(HumanInput.unreadableKeys(stored)).toEqual([]);
  });

  it("replaces its own key when it doesn't parse", () => {
    const stored = store({ authored: 1, "eve.harness.humanInput": 42 }, readState(undefined));
    expect(stored).toEqual({ authored: 1 });
  });
});
