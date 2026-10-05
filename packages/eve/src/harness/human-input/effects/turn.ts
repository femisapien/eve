import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import {
  PendingAuthorizationResultKey,
  ReceivedAuthorizationCallbacksKey,
} from "#harness/authorization.js";
import {
  advanceStep,
  getHarnessEmissionState,
  setHarnessEmissionState,
} from "#harness/emission.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import {
  HumanInput,
  type Carried,
  type Ending,
  type HostEventOf,
  type HumanInputHost,
  type InputOf,
} from "#harness/human-input/index.js";
import { createFrameworkUserMessage, validateHarnessModelMessages } from "#harness/messages.js";
import { bumpSessionRuntimeUsageLimits, getSessionUsage } from "#harness/turn-tag-state.js";
import type {
  HarnessSession,
  StepInput,
  StepResult,
  ToolLoopHarnessConfig,
} from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

import { runApprovedWork } from "./approved-calls.js";
import { checkResponder } from "./response-policy.js";
import { prepareStepTools, type StepEffects } from "./step-tools.js";

export type { StepEffects } from "./step-tools.js";

type Emit = ToolLoopHarnessConfig["handleEvent"];

/** Where in the turn human input is committed: before the step's model call, or after it. */
export type TurnPhase = "pre-step" | "post-step";

/**
 * Carries out, in the tool loop's step, what human input reports. Each event
 * has one meaning here, so the tool loop decides nothing about a person's
 * input. Each phase has its host, which carries out only that phase's events.
 */
abstract class TurnStepHost {
  readonly #emit: Emit | undefined;
  readonly #emissionState: HarnessEmissionState;

  constructor(input: { readonly emit?: Emit; readonly emissionState: HarnessEmissionState }) {
    this.#emit = input.emit;
    this.#emissionState = input.emissionState;
  }

  protected get emit(): Emit | undefined {
    return this.#emit;
  }

  async publish(event: UnstampedMessageStreamEvent): Promise<void> {
    await this.#emit?.(event);
  }

  /** A held turn reports `turn.waiting` at the step after this one, which it resumes at. */
  waitingAt(session: HarnessSession) {
    const next = advanceStep(this.#emissionState);
    return { sequence: next.sequence, turnId: next.turnId, usage: getSessionUsage(session) };
  }
}

/**
 * The step before a model call, where what arrived for the turn is read:
 * answers, messages, callbacks, the budget. Running response policies needs
 * `effects`; a host that commits only a budget Stop has none.
 */
export class PreStepHost
  extends TurnStepHost
  implements HumanInputHost<HarnessSession, "pre-step">
{
  readonly phase = "pre-step";
  /** A message answered open requests, so the turn doesn't read it as input. */
  messageAnswered = false;
  readonly #effects: StepEffects | undefined;

  constructor(input: {
    readonly effects?: StepEffects;
    readonly emit?: Emit;
    readonly emissionState: HarnessEmissionState;
  }) {
    super(input);
    this.#effects = input.effects;
  }

  async carry(
    event: HostEventOf<"pre-step">,
    session: HarnessSession,
  ): Promise<Carried<HarnessSession, "pre-step">> {
    switch (event.type) {
      case "history.appended":
        return { session: appended(session, event.message) };
      case "note":
        return {
          session: appended(session, createFrameworkUserMessage("context.instruction", event.text)),
        };
      case "message.answered":
        this.messageAnswered = true;
        return { session };
      case "sign-in.completed": {
        const ctx = contextStorage.getStore();
        if (ctx !== undefined) {
          ctx.set(PendingAuthorizationResultKey, [
            ...(ctx.get(PendingAuthorizationResultKey) ?? []),
            event.result,
          ]);
          if (event.requester !== null) ctx.set(AuthKey, event.requester);
        }
        return { session };
      }
      case "budget.granted":
        return { session: bumpSessionRuntimeUsageLimits(session) };
      case "responder.check": {
        if (this.#effects === undefined) {
          throw new Error(`Human input event "${event.type}" needs the step's tools.`);
        }
        const tools = await prepareStepTools(this.#effects, event.at, session);
        return { report: [await checkResponder(event, tools)], session };
      }
    }
  }
}

/**
 * The step after a model call, or the step a person's approval runs without
 * one: where the calls a step made are held, dispatched, and settled.
 */
export class PostStepHost
  extends TurnStepHost
  implements HumanInputHost<HarnessSession, "post-step">
{
  readonly phase = "post-step";
  /** The turn input that waited behind the suspended step's calls, which joined history. */
  following: StepInput | undefined;
  readonly #effects: StepEffects;

  constructor(input: {
    readonly effects: StepEffects;
    readonly emit?: Emit;
    readonly emissionState: HarnessEmissionState;
  }) {
    super(input);
    this.#effects = input.effects;
  }

  async carry(
    event: HostEventOf<"post-step">,
    session: HarnessSession,
  ): Promise<Carried<HarnessSession, "post-step">> {
    switch (event.type) {
      case "history.appended":
        return { session: appended(session, event.message) };
      case "input.resumed":
        this.following = event.input;
        return { session };
      case "calls.approved": {
        const effects = this.#effects;
        const tools = await prepareStepTools(effects, event.at, session);
        const work = await runApprovedWork({
          ...event,
          abortSignal: effects.config.abortSignal,
          emit: this.emit,
          messages: [
            ...effects.projectHistory(session.history, session.state),
            ...HumanInput.read(session.state).suspendedMessages(),
          ],
          session,
          tools,
        });
        return {
          report: [
            {
              results:
                work.results.length === 0 ? [] : [{ content: [...work.results], role: "tool" }],
              running: work.runtimeCalls?.tasks ?? [],
              ...(work.signIns !== undefined && { signIns: work.signIns }),
              type: "calls.settled",
            },
          ],
          session: work.session,
        };
      }
    }
  }
}

/** A host in the tool loop's step. */
export type TurnHost = PreStepHost | PostStepHost;

function appended(session: HarnessSession, message: ModelMessage): HarnessSession {
  return { ...session, history: validateHarnessModelMessages([...session.history, message]) };
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
): Promise<{ readonly ended?: StepResult; readonly session: HarnessSession }> {
  const committed = await HumanInput.commit(host, session, input);
  if (committed.ending === undefined) return { session: committed.session };
  return {
    ended: { cancelled: committed.ending, next: null, session: committed.session },
    session: committed.session,
  };
}

/**
 * Hands what arrived for the turn to human input before the step's model
 * call. Returns the step's result when that ends, parks, or holds the step;
 * otherwise the input the turn reads, without a message that answered.
 */
export async function applyStepArrivals(input: {
  readonly auth: SessionAuthContext | null;
  readonly effects: StepEffects;
  readonly emit?: Emit;
  readonly emissionState: HarnessEmissionState;
  readonly session: HarnessSession;
  readonly stepInput: StepInput | undefined;
}): Promise<
  | { readonly result: StepResult }
  | { readonly session: HarnessSession; readonly turnInput: StepInput | undefined }
> {
  const { effects, emit, emissionState, stepInput } = input;
  let { session } = input;
  const host = new PreStepHost({ effects, emit, emissionState });
  const arrivals = HumanInput.read(session.state).arrivals({
    callbacks: contextStorage.getStore()?.get(ReceivedAuthorizationCallbacksKey) ?? [],
    now: Date.now(),
    sender: input.auth,
    stepInput,
  });
  for (const intake of arrivals) {
    const committed = await commitTurn(host, session, intake);
    session = committed.session;
    if (committed.ended !== undefined) return { result: committed.ended };
  }
  let turnInput = host.messageAnswered ? withoutMessage(stepInput) : stepInput;
  if (isApprovedStep(HumanInput.read(session.state).next())) {
    const ran = await runApprovedStep({ effects, emit, emissionState, session, turnInput });
    if ("result" in ran) return ran;
    ({ session, turnInput } = ran);
  }
  // A message that answers nothing still joins history, so it is read once
  // the turn runs again; the hold before the model call keeps it.
  if ("held" in HumanInput.read(session.state).next() && turnInput?.message === undefined) {
    return { result: await holdForInput({ emissionState, host, session }) };
  }
  return { session, turnInput };
}

/**
 * Runs the calls a person approved as a step without a model call, through
 * the post-step settle: their results join the suspended step, the calls
 * that ask for a sign-in leave it as their sign-ins open, and calls that run
 * as runtime work park the turn. The turn input that arrived with the
 * answers waits behind them; it is the turn's input once the step joins
 * history.
 */
async function runApprovedStep(input: {
  readonly effects: StepEffects;
  readonly emit?: Emit;
  readonly emissionState: HarnessEmissionState;
  readonly session: HarnessSession;
  readonly turnInput: StepInput | undefined;
}): Promise<
  | { readonly result: StepResult }
  | { readonly session: HarnessSession; readonly turnInput: StepInput | undefined }
> {
  const { effects, emit, emissionState } = input;
  const host = new PostStepHost({ effects, emit, emissionState });
  const following = followingInput(input.turnInput);
  const ran = await commitTurn(host, input.session, {
    ...(following !== undefined && { following }),
    type: "approved.run",
  });
  if (ran.ended !== undefined) return { result: ran.ended };
  if (HumanInput.read(ran.session.state).runtimeCalls() !== undefined) {
    // The turn parks on them; it reads its input after their results.
    return {
      result: {
        next: null,
        session: setHarnessEmissionState(ran.session, advanceStep(emissionState)),
      },
    };
  }
  return { session: ran.session, turnInput: host.following };
}

function isApprovedStep(next: ReturnType<HumanInput["next"]>): boolean {
  return "run" in next && next.run === "calls";
}

/**
 * The turn waits on a person, as it waits on a task: it reports `turn.waiting`
 * and resumes in the same turn once the person answers, steers, or cancels.
 */
export async function holdForInput(input: {
  readonly emissionState: HarnessEmissionState;
  readonly host: TurnHost;
  readonly session: HarnessSession;
}): Promise<StepResult> {
  const { session } =
    input.host instanceof PreStepHost
      ? await HumanInput.commit(input.host, input.session, { type: "turn.holding" })
      : await HumanInput.commit(input.host, input.session, { type: "turn.holding" });
  return {
    held: { kind: "input" },
    next: null,
    session: setHarnessEmissionState(session, advanceStep(input.emissionState)),
  };
}

/**
 * The session a turn a budget Stop ended settles from as cancelled: `session`,
 * from before the step that read the Stop, with that question closed again so
 * the cancel doesn't withdraw it a second time. Other endings keep `session`.
 */
export async function settledByEnding(
  session: HarnessSession,
  ending: Ending,
): Promise<HarnessSession> {
  if (ending.declined !== "budget") return session;
  const host = new PreStepHost({ emissionState: getHarnessEmissionState(session.state) });
  const settled = await HumanInput.commit(host, session, {
    requestId: ending.requestId,
    type: "budget.stopped",
  });
  return settled.session;
}

/** A message that answered requests isn't turn input, nor is the context sent with it. */
function withoutMessage(input: StepInput | undefined): StepInput | undefined {
  if (input === undefined) return undefined;
  const { context: _context, message: _message, ...rest } = input;
  return rest;
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
