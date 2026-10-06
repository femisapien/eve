import { advanceStep, setHarnessEmissionState } from "#harness/emission.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import type { HostEventOf, HumanInput } from "#harness/hitl/index.js";
import type { HarnessSession, StepFn, StepInput, StepResult } from "#harness/types.js";

import { runApprovedWork } from "./approved-call.js";
import { prepareStepTools, type StepEffects } from "./step-tools.js";
import { appended, commitTurn, TurnStepHost, type Emit } from "./turn.js";

/**
 * The step after a model call, or the step that runs the calls a person
 * approved: where the calls a step made are held, dispatched, and settled.
 */
export class PostStepHost extends TurnStepHost<"post-step"> {
  readonly phase = "post-step";

  async carry(event: HostEventOf<"post-step">, session: HarnessSession): Promise<HarnessSession> {
    switch (event.type) {
      case "appendHistory":
        return appended(session, event.message);
    }
  }
}

/**
 * Runs the calls a person approved, before the model runs again, and settles
 * them post-step: their results join the held step, the calls that ask for a
 * authorization leave it as their authorizations open, and calls that run as runtime work
 * park the turn. The turn input that arrived with the
 * answers waits behind them. Once the step joins history, the step ends;
 * the next step reads that input after the step's results. A step still
 * held, on an authorization its calls opened, waits on a person.
 */
export async function runApprovedStep(input: {
  readonly effects: StepEffects;
  readonly emit?: Emit;
  readonly emissionState: HarnessEmissionState;
  /** The human input `session` holds. */
  readonly humanInput: HumanInput;
  readonly runStep: StepFn;
  readonly session: HarnessSession;
  readonly turnInput: StepInput | undefined;
}): Promise<
  | { readonly result: StepResult }
  | { readonly humanInput: HumanInput; readonly session: HarnessSession }
> {
  const { effects, emit, emissionState } = input;
  const host = new PostStepHost({ emit, emissionState });
  const following = followingInput(input.turnInput);
  const approved = input.humanInput.approvedCalls();
  if (approved === undefined) throw new Error("Human input has no approved calls to run.");
  const tools = await prepareStepTools(effects, approved.at, input.session);
  const work = await runApprovedWork({
    ...approved,
    abortSignal: effects.config.abortSignal,
    emit,
    messages: [
      ...effects.projectHistory(input.session.history, input.session.state),
      ...input.humanInput.heldMessages(),
    ],
    session: input.session,
    tools,
  });
  const ran = await commitTurn(host, work.session, {
    approved: following === undefined ? {} : { following },
    results: work.results.length === 0 ? [] : [{ content: [...work.results], role: "tool" }],
    running: work.runtimeCalls?.tasks ?? [],
    runningApprovers: work.runtimeCalls?.approvers,
    ...(work.authorizations !== undefined && { authorizations: work.authorizations }),
    type: "actions.settled",
  });
  if (ran.ended !== undefined) return { result: ran.ended };
  const { humanInput } = ran;
  if (humanInput.isWaitingForInput()) return { humanInput, session: ran.session };
  // The turn parks on runtime calls and reads its input after their results;
  // otherwise its next step reads the results first, before anything that
  // arrived while the calls ran.
  const session = setHarnessEmissionState(ran.session, advanceStep(emissionState));
  if (humanInput.runtimeCalls() !== undefined) return { result: { next: null, session } };
  return { result: { next: input.runStep, readsResults: true, session } };
}

/**
 * What of the turn input waits behind approved calls: everything but the
 * answers, already applied, and runtime results, already read. `undefined`
 * when nothing is left.
 */
function followingInput(input: StepInput | undefined): StepInput | undefined {
  if (input === undefined) return undefined;
  const {
    attributedInputResponses: _attributed,
    inputResponses: _responses,
    runtimeActionResults: _results,
    ...rest
  } = input;
  return Object.values(rest).some((value) => value !== undefined) ? rest : undefined;
}
