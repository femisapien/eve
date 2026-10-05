import { describe, expect, it } from "vitest";

import {
  HumanInput,
  type Carried,
  type EventOrigin,
  type HostEvent,
  type HumanInputHost,
} from "#harness/human-input/index.js";
import type { SessionStateMap } from "#harness/types.js";
import {
  BUDGET_QUESTION,
  answer,
  approval,
  approvalsRequested,
  overBudget,
} from "#internal/testing/human-input.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

interface Session {
  readonly state?: SessionStateMap;
}

/** A host that records what `commit` hands it, and reports `report` back for the events it carries. */
class RecordingHost implements HumanInputHost<Session> {
  readonly published: [EventOrigin, UnstampedMessageStreamEvent][] = [];
  readonly carried: HostEvent["type"][] = [];

  constructor(
    readonly report: Partial<Record<HostEvent["type"], Carried<Session>["report"]>> = {},
  ) {}

  async publish(event: UnstampedMessageStreamEvent, origin: EventOrigin): Promise<void> {
    this.published.push([origin, event]);
  }

  waitingAt() {
    return { sequence: 9, turnId: "turn_1" };
  }

  async carry(event: HostEvent, session: Session): Promise<Carried<Session>> {
    this.carried.push(event.type);
    const report = this.report[event.type];
    return report === undefined ? { session } : { report, session };
  }
}

describe("HumanInput.commit", () => {
  it("stores what the rules leave and publishes what they report", async () => {
    const host = new RecordingHost();

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
    const host = new RecordingHost();
    const asked = await HumanInput.commit(host, {}, overBudget());

    const stopped = await HumanInput.commit(
      host,
      asked.session,
      answer("stop", BUDGET_QUESTION.requestId),
    );

    expect(stopped.ending).toEqual({ declined: "budget", kind: "cancelled" });
    expect(HumanInput.read(stopped.session.state).openRequestIds().size).toBe(0);
    expect(host.carried).toEqual([]);
  });

  it("commits what a host reports back, in order, through the same rules", async () => {
    const host = new RecordingHost({
      "calls.approved": [{ results: [], running: [], stopped: [], type: "calls.settled" }],
    });
    const held = await HumanInput.commit(host, {}, approvalsRequested([approval("deploy")]));

    const approved = await HumanInput.commit(host, held.session, answer("approve", "deploy"));

    expect(host.carried).toContain("calls.approved");
    expect(host.carried.indexOf("calls.approved")).toBeLessThan(
      host.carried.lastIndexOf("history.appended"),
    );
    expect(HumanInput.read(approved.session.state).next()).toEqual({ run: "model" });
  });

  it("is the one place that reports the turn waits on input, at the step the host holds at", async () => {
    const host = new RecordingHost();

    await HumanInput.hold(host, {});

    expect(host.published).toEqual([
      ["own", { data: { on: "input", sequence: 9, turnId: "turn_1" }, type: "turn.waiting" }],
    ]);
  });
});
