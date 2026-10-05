import { describe, expect, it } from "vitest";

import {
  HumanInput,
  type Carried,
  type HostEventOf,
  type HumanInputHost,
  type InputOf,
  type Phase,
} from "#harness/human-input/index.js";
import type { SessionStateMap } from "#harness/types.js";
import {
  AT,
  answer,
  approval,
  approvalsRequested,
  callback,
  cancel,
  challenge,
  message,
  overBudget,
  signInRequired,
} from "#internal/testing/human-input.js";

interface Session {
  readonly state?: SessionStateMap;
}

/** A host that carries nothing out: the phase is all these tests are about. */
class Host<P extends Phase> implements HumanInputHost<Session, P> {
  readonly phase: P;

  constructor(phase: P) {
    this.phase = phase;
  }

  async publish(): Promise<void> {}

  waitingAt() {
    return { sequence: 1, turnId: "turn_1" };
  }

  async carry(_event: HostEventOf<P>, session: Session): Promise<Carried<Session, P>> {
    return { session };
  }
}

const preStep = new Host("pre-step");
const postStep = new Host("post-step");
const parked = new Host("parked");

const relayedRequest: Extract<InputOf<"parked">, { type: "relayed.requested" }> = {
  at: AT,
  requests: [approval("deploy")],
  route: { childContinuationToken: "child_1", runId: "run_1" },
  type: "relayed.requested",
};
const settled: Extract<InputOf<"post-step">, { type: "calls.settled" }> = {
  results: [],
  type: "calls.settled",
};

/**
 * Each kind opens and resolves only in its phase: these calls must not
 * compile. `tsc` checks them; the test never runs them.
 */
function wrongPhases(): void {
  const s: Session = {};
  // Approvals and sign-ins open post-step, after the model step that asked.
  // @ts-expect-error approvals open post-step
  void HumanInput.commit(preStep, s, approvalsRequested([approval("deploy")]));
  // @ts-expect-error sign-ins open post-step
  void HumanInput.commit(preStep, s, signInRequired([challenge("a1")]));
  // @ts-expect-error a held step's calls settle post-step
  void HumanInput.commit(preStep, s, settled);
  // @ts-expect-error approved calls run post-step
  void HumanInput.commit(preStep, s, { type: "approved.run" });
  // ...and resolve pre-step, where answers and callbacks arrive.
  // @ts-expect-error answers resolve pre-step
  void HumanInput.commit(postStep, s, answer("approve", "deploy"));
  // @ts-expect-error callbacks resolve pre-step
  void HumanInput.commit(postStep, s, callback("a1"));
  // @ts-expect-error a message steers pre-step
  void HumanInput.commit(postStep, s, message("Never mind."));
  // The budget question opens and resolves pre-step.
  // @ts-expect-error the budget opens pre-step
  void HumanInput.commit(postStep, s, overBudget());
  // @ts-expect-error the budget opens pre-step
  void HumanInput.commit(parked, s, overBudget());
  // Relayed requests open and resolve while the turn is parked.
  // @ts-expect-error relayed requests open parked
  void HumanInput.commit(preStep, s, relayedRequest);
  // @ts-expect-error relayed requests open parked
  void HumanInput.commit(postStep, s, relayedRequest);
  // @ts-expect-error a delivery for a relayed request arrives parked
  void HumanInput.commit(preStep, s, { responses: [], type: "delivered" });
  // A cancel settles once the turn stops, while it is parked.
  // @ts-expect-error a cancel settles parked
  void HumanInput.commit(preStep, s, cancel);
}

describe("human input phases", () => {
  it("each kind compiles only in its own host", () => {
    expect(wrongPhases).toBeTypeOf("function");
  });

  it("refuses an input cast past its phase", async () => {
    await expect(
      HumanInput.commit(preStep, {}, approvalsRequested([approval("deploy")]) as never),
    ).rejects.toThrow('Human input "approvals.requested" can\'t be committed pre-step.');
    await expect(HumanInput.commit(postStep, {}, overBudget() as never)).rejects.toThrow(
      'Human input "budget.exceeded" can\'t be committed post-step.',
    );
    await expect(HumanInput.commit(preStep, {}, relayedRequest as never)).rejects.toThrow(
      'Human input "relayed.requested" can\'t be committed pre-step.',
    );
  });
});
