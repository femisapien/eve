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
import type { SessionStateMap } from "#harness/types.js";
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
    "ends the turn when cancelled %s, leaving relayed requests for the parked settle to withdraw",
    async (phase) => {
      const relaying = new RecordingHost("parked");
      const relayed = await HumanInput.commit(
        relaying,
        {},
        {
          at: AT,
          requests: [approval("child-deploy")],
          route: { childContinuationToken: "child_1", runId: "run_1" },
          type: "relayed.requested",
        },
      );
      const held = await HumanInput.commit(
        new RecordingHost("post-step"),
        relayed.session,
        approvalsRequested([approval("deploy")]),
      );
      const host = new RecordingHost(phase);

      const cancelled = await HumanInput.commit(host, held.session, cancel);

      expect(cancelled.ending).toEqual({ kind: "cancelled" });
      // A turn's host publishes to the turn's own stream; relayed events aren't its to carry.
      expect(host.published.filter(([origin]) => origin === "relayed")).toEqual([]);
      const left = HumanInput.read(cancelled.session.state);
      expect(left.next()).toEqual({ run: "model" });
      expect(left.relayedRequestIds()).toEqual(new Set(["child-deploy"]));

      // The cancelled turn settles parked, which withdraws what the child asked.
      const parked = new RecordingHost("parked");
      const settled = await HumanInput.commit(parked, cancelled.session, cancel);
      expect(
        settled.ending === undefined &&
          parked.published.some(
            ([origin, event]) => origin === "relayed" && event.type === "input.resolved",
          ),
      ).toBe(true);
      expect(HumanInput.read(settled.session.state).relayedRequestIds().size).toBe(0);
    },
  );
});
