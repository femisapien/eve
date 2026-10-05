import { describe, expect, it } from "vitest";

import {
  HumanInput,
  type Carried,
  type EventOrigin,
  type HostEvent,
  type HostEventOf,
  type HumanInputHost,
  type Phase,
} from "#harness/human-input/index.js";
import { settledByEnding } from "#harness/human-input/effects/index.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import {
  AT,
  BUDGET_QUESTION,
  answer,
  approval,
  approvalsRequested,
  cancel,
  overBudget,
} from "#internal/testing/human-input.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

interface Session {
  readonly state?: SessionStateMap;
}

/** A host that records what `commit` hands it, and reports `report` back for the events it carries. */
class RecordingHost<P extends Phase> implements HumanInputHost<Session, P> {
  readonly phase: P;
  readonly published: [EventOrigin, UnstampedMessageStreamEvent][] = [];
  readonly carried: HostEvent["type"][] = [];
  readonly report: Partial<Record<HostEvent["type"], Carried<Session, P>["report"]>>;

  constructor(
    phase: P,
    report: Partial<Record<HostEvent["type"], Carried<Session, P>["report"]>> = {},
  ) {
    this.phase = phase;
    this.report = report;
  }

  async publish(event: UnstampedMessageStreamEvent, origin: EventOrigin): Promise<void> {
    this.published.push([origin, event]);
  }

  waitingAt() {
    return { sequence: 9, turnId: "turn_1" };
  }

  async carry(event: HostEventOf<P>, session: Session): Promise<Carried<Session, P>> {
    this.carried.push(event.type);
    const report = this.report[event.type];
    return report === undefined ? { session } : { report, session };
  }
}

const harnessSession: HarnessSession = {
  agent: { modelReference: { id: "model" }, system: "", tools: [] },
  compaction: { recentWindowSize: 10, threshold: 100_000 },
  continuationToken: "http:session",
  history: [],
  sessionId: "session",
};

describe("HumanInput.commit", () => {
  it("stores what the rules leave and publishes what they report", async () => {
    const host = new RecordingHost("pre-step");

    const { ending, session } = await HumanInput.commit(
      host,
      { state: { other: 1 } },
      overBudget(),
    );

    expect(ending).toBeUndefined();
    expect(session.state?.other).toBe(1);
    expect(HumanInput.read(session.state).openRequestIds()).toEqual(
      new Set([BUDGET_QUESTION.requestId]),
    );
    expect(host.published.map(([origin, event]) => [origin, event.type])).toEqual([
      ["own", "input.requested"],
    ]);
  });

  it("ends the turn as cancelled when the person stops at the budget question, keeping the answer", async () => {
    const host = new RecordingHost("pre-step");
    const asked = await HumanInput.commit(host, {}, overBudget());

    const stopped = await HumanInput.commit(
      host,
      asked.session,
      answer("stop", BUDGET_QUESTION.requestId),
    );

    expect(stopped.ending).toEqual({
      declined: "budget",
      kind: "cancelled",
      requestId: BUDGET_QUESTION.requestId,
    });
    expect(HumanInput.read(stopped.session.state).openRequestIds().size).toBe(0);
    expect(host.carried).toEqual([]);
  });

  it("commits what a host reports back, in order, through the same rules", async () => {
    const host = new RecordingHost("post-step", {
      "calls.approved": [{ results: [], running: [], type: "calls.settled" }],
    });
    const held = await HumanInput.commit(host, {}, approvalsRequested([approval("deploy")]));
    const answered = await HumanInput.commit(
      new RecordingHost("pre-step"),
      held.session,
      answer("approve", "deploy"),
    );

    const approved = await HumanInput.commit(host, answered.session, { type: "approved.run" });

    expect(host.carried).toContain("calls.approved");
    expect(host.carried.indexOf("calls.approved")).toBeLessThan(
      host.carried.lastIndexOf("history.appended"),
    );
    expect(HumanInput.read(approved.session.state).next()).toEqual({ run: "model" });
  });

  it("reports the turn waits on input when it holds, at the step the host holds at", async () => {
    const host = new RecordingHost("pre-step");

    const held = await HumanInput.commit(host, { state: { other: 1 } }, { type: "turn.holding" });

    expect(held.session.state).toEqual({ other: 1 });
    expect(host.published).toEqual([
      ["own", { data: { on: "input", sequence: 9, turnId: "turn_1" }, type: "turn.waiting" }],
    ]);
  });

  it("closes the question a budget Stop answered, publishing nothing, for the session the cancel settles from", async () => {
    const host = new RecordingHost("pre-step");
    const beforeStop = await HumanInput.commit(host, {}, overBudget());
    const stopped = await HumanInput.commit(
      host,
      beforeStop.session,
      answer("stop", BUDGET_QUESTION.requestId),
    );
    if (stopped.ending?.declined !== "budget") throw new Error("expected a budget Stop");
    host.published.length = 0;

    const settled = await HumanInput.commit(host, beforeStop.session, {
      requestId: stopped.ending.requestId,
      type: "budget.stopped",
    });
    const cancelled = await HumanInput.commit(new RecordingHost("parked"), settled.session, {
      type: "cancelled",
    });

    expect(settled.session.state).toBeUndefined();
    // The cancel finds nothing to withdraw, so the question resolves once.
    expect(host.published).toEqual([]);
    expect(cancelled.session.state).toBeUndefined();
  });

  it.each(["pre-step", "post-step"] as const)(
    "resolves each request once when cancelled %s and settled from the session saved before the step",
    async (phase) => {
      const relayed = await HumanInput.commit(
        new RecordingHost("parked"),
        {},
        {
          at: AT,
          requests: [approval("child-deploy")],
          route: { childContinuationToken: "child_1", runId: "run_1" },
          type: "relayed.requested",
        },
      );
      // The session saved before the step, which the cancelled turn settles from.
      const saved = await HumanInput.commit(
        new RecordingHost("post-step"),
        relayed.session,
        approvalsRequested([approval("deploy")]),
      );
      const host = new RecordingHost(phase);

      const cancelled = await HumanInput.commit(host, saved.session, cancel);

      expect(cancelled.ending).toEqual({ closed: "own", kind: "cancelled" });
      // A turn's host publishes to the turn's own stream; relayed events aren't its to carry.
      expect(resolvedIds(host, "relayed")).toEqual([]);
      expect(resolvedIds(host, "own")).toEqual(["deploy"]);

      // The step's work rolls back; what the cancel reported stays closed.
      const settleFrom = new RecordingHost("pre-step");
      const carried = await HumanInput.commit(settleFrom, saved.session, {
        type: "cancel.carried",
      });
      expect(settleFrom.published).toEqual([]);
      const parked = new RecordingHost("parked");
      const settled = await HumanInput.commit(parked, carried.session, cancel);

      expect(resolvedIds(parked, "own")).toEqual([]);
      expect(resolvedIds(parked, "relayed")).toEqual(["child-deploy"]);
      // The step's call joins history once, with its not-run result.
      expect(parked.carried).toContain("history.appended");
      expect(HumanInput.read(settled.session.state).heldStep()).toBeUndefined();
      expect(HumanInput.read(settled.session.state).relayedRequestIds().size).toBe(0);
    },
  );

  it("settles from the saved session with the cancel's closures only when a cancel in the step closed them", async () => {
    const held = await HumanInput.commit(
      new RecordingHost("post-step"),
      {},
      approvalsRequested([approval("deploy")]),
    );
    const saved = { ...harnessSession, state: held.session.state };

    const afterCancel = await settledByEnding(saved, { closed: "own", kind: "cancelled" });
    // Another ending, such as a relayed Stop, closed nothing of the turn's own.
    const afterOther = await settledByEnding(saved, { kind: "cancelled" });

    expect(HumanInput.read(afterCancel.state).openRequestIds().size).toBe(0);
    expect(HumanInput.read(afterCancel.state).heldStep()).toBeDefined();
    expect(afterOther).toBe(saved);
  });
});

function resolvedIds(host: RecordingHost<Phase>, origin: EventOrigin): string[] {
  return host.published.flatMap(([from, event]) =>
    from === origin && event.type === "input.resolved"
      ? event.data.resolutions.map((resolution) => resolution.requestId)
      : [],
  );
}
