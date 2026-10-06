import type { ModelMessage } from "ai";

import { advanceStep, setHarnessEmissionState } from "#harness/emission.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import {
  HumanInput,
  type HostEventOf,
  type HumanInputHost,
  type InputOf,
} from "#harness/hitl/index.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import type { HarnessSession, StepResult, ToolLoopHarnessConfig } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

export type { StepEffects } from "./step-tools.js";

export type Emit = ToolLoopHarnessConfig["handleEvent"];

/** Where in the turn human input is committed: before the step's model call, or after it. */
export type TurnPhase = "pre-step" | "post-step";

/**
 * Carries out, in the tool loop's step, what human input reports. Each event
 * has one meaning here, so the tool loop decides nothing about a person's
 * input. Each phase has its host, which carries out only that phase's events:
 * `PreStepHost` in `turn-pre-step.ts`, `PostStepHost` in `turn-post-step.ts`.
 */
export abstract class TurnStepHost<P extends TurnPhase> implements HumanInputHost<
  HarnessSession,
  P
> {
  abstract readonly phase: P;
  readonly #emit: Emit | undefined;
  readonly #emissionState: HarnessEmissionState;

  constructor(input: { readonly emit?: Emit; readonly emissionState: HarnessEmissionState }) {
    this.#emit = input.emit;
    this.#emissionState = input.emissionState;
  }

  abstract carry(event: HostEventOf<P>, session: HarnessSession): Promise<HarnessSession>;

  async publish(event: UnstampedMessageStreamEvent): Promise<void> {
    await this.#emit?.(event);
  }

  /** A waiting turn reports `turn.waiting` at the step after this one, which it resumes at. */
  waitingAt(session: HarnessSession) {
    const next = advanceStep(this.#emissionState);
    return { sequence: next.sequence, turnId: next.turnId, usage: getSessionUsage(session) };
  }
}

/** A host in the tool loop's step. */
export type TurnHost = TurnStepHost<"pre-step"> | TurnStepHost<"post-step">;

export function appended(session: HarnessSession, message: ModelMessage): HarnessSession {
  return { ...session, history: validateHarnessModelMessages([...session.history, message]) };
}

/** What a commit in the turn left: the session, its human input, and how the turn ended. */
export interface TurnCommitted {
  /** The step's result when the commit ended the turn. */
  readonly ended?: StepResult;
  /** The human input `session` holds, already read. */
  readonly humanInput: HumanInput;
  readonly session: HarnessSession;
}

/**
 * Commits what happened to the turn's human input. Returns the step's result
 * when that ended the turn: the person stopped at the budget question, which
 * ends it as cancelled.
 */
export async function commitTurn<P extends TurnPhase>(
  host: HumanInputHost<HarnessSession, P>,
  session: HarnessSession,
  input: NoInfer<InputOf<P>>,
): Promise<TurnCommitted> {
  const committed = await HumanInput.commit(host, session, input);
  const { humanInput } = committed;
  if (committed.ending === undefined) return { humanInput, session: committed.session };
  return {
    ended: { cancelled: committed.ending, next: null, session: committed.session },
    humanInput,
    session: committed.session,
  };
}

/**
 * The turn waits on a person, as it waits on a task: it reports `turn.waiting`
 * and resumes in the same turn once the person answers, steers, or cancels.
 */
export async function waitForInput(input: {
  readonly emissionState: HarnessEmissionState;
  readonly host: TurnHost;
  readonly session: HarnessSession;
}): Promise<StepResult> {
  const { session } =
    input.host.phase === "pre-step"
      ? await HumanInput.commit(input.host, input.session, { type: "turn.waiting" })
      : await HumanInput.commit(input.host, input.session, { type: "turn.waiting" });
  return {
    waiting: { kind: "input" },
    next: null,
    session: setHarnessEmissionState(session, advanceStep(input.emissionState)),
  };
}
