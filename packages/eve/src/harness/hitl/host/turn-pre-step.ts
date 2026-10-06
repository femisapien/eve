import type { SessionAuthContext } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import {
  PendingAuthorizationResultKey,
  type ReceivedAuthorizationCallback,
} from "#harness/authorization.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import {
  HumanInput,
  type Ending,
  type HostEventOf,
  type InputOf,
  type PolicyCheck,
  type PolicyRun,
  type Verdicts,
} from "#harness/hitl/index.js";
import { coalesceTurnInputs, createFrameworkUserMessage } from "#harness/messages.js";
import { bumpSessionRuntimeUsageLimits } from "#harness/turn-tag-state.js";
import type { HarnessSession, StepInput, StepFn, StepResult } from "#harness/types.js";
import { createMessageReceivedEvent } from "#protocol/message.js";

import { runPolicy } from "./approval-candidate-policy.js";
import { prepareStepTools, type StepEffects } from "./step-tools.js";
import { appended, commitTurn, TurnStepHost, waitForInput, type Emit } from "./turn.js";
import { runApprovedStep } from "./turn-post-step.js";

/**
 * The step before a model call, where what arrived for the turn is read:
 * answers, messages, callbacks, the budget.
 */
export class PreStepHost extends TurnStepHost<"pre-step"> {
  readonly phase = "pre-step";
  /** A message answered open requests, so the turn doesn't read it as input. */
  messageAnswered = false;
  /** The turn input that waited behind the last step's calls, which joined history. */
  resumed: StepInput | undefined;

  async carry(event: HostEventOf<"pre-step">, session: HarnessSession): Promise<HarnessSession> {
    switch (event.type) {
      case "appendHistory":
        return appended(session, event.message);
      case "addNote":
        return appended(session, createFrameworkUserMessage("context.instruction", event.text));
      case "consumeMessage":
        this.messageAnswered = true;
        return session;
      case "resumeInput":
        this.resumed = event.input;
        return session;
      case "resumeAuthorization":
        resumeAuthorization(event.result, event.requester);
        return session;
      case "grantBudget":
        return bumpSessionRuntimeUsageLimits(session);
    }
  }
}

/**
 * Hands an authorization's callback to the step's tools; `requester` becomes
 * who the turn runs as. Human input keeps the callback until the step that can
 * use it, so here it is step-local: one no tool consumes is gone after it.
 */
function resumeAuthorization(
  result: NonNullable<PolicyCheck["authorizations"]>[number],
  requester: SessionAuthContext | null,
): void {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) return;
  ctx.setVirtualContext(PendingAuthorizationResultKey, [
    ...(ctx.get(PendingAuthorizationResultKey) ?? []),
    result,
  ]);
  if (requester !== null) ctx.set(AuthKey, requester);
}

/**
 * Runs the response policies `checks` names, with the tools of the step that
 * asked, and returns what each did. A policy that runs again once its
 * responder authorized reads the callback; the policy binds its responder
 * itself, so the turn's person stays who the turn runs as.
 */
async function runPolicyChecks(
  checks: readonly PolicyCheck[],
  effects: StepEffects,
  session: HarnessSession,
): Promise<Verdicts> {
  const verdicts: Record<string, PolicyRun> = {};
  for (const check of checks) {
    for (const result of check.authorizations ?? []) resumeAuthorization(result, null);
    const tools = await prepareStepTools(effects, check.at, session);
    verdicts[check.candidateId] = await runPolicy(check, tools);
  }
  return verdicts;
}

/**
 * Hands what arrived for the turn to human input before the step's model
 * call. Returns the step's result when that ends, parks, or waits;
 * otherwise the input the turn reads, without a message that answered.
 */
export async function applyStepArrivals(input: {
  readonly auth: SessionAuthContext | null;
  /** The authorization callbacks the step's delivery carried. */
  readonly callbacks: readonly ReceivedAuthorizationCallback[];
  readonly effects: StepEffects;
  readonly emit?: Emit;
  readonly emissionState: HarnessEmissionState;
  /** The human input `session` holds. */
  readonly humanInput: HumanInput;
  /** The message as the person sent it, which a step of approved calls reports received. */
  readonly received?: StepInput["message"];
  /** The step that follows a step of approved calls, which runs without a model call. */
  readonly runStep: StepFn;
  readonly session: HarnessSession;
  readonly stepInput: StepInput | undefined;
}): Promise<
  | { readonly result: StepResult }
  | {
      /** The human input `session` holds. */
      readonly humanInput: HumanInput;
      readonly session: HarnessSession;
      readonly turnInput: StepInput | undefined;
      /** The turn input that waited behind the last step's calls, now part of `turnInput`. */
      readonly resumed?: StepInput;
    }
> {
  const { effects, emit, emissionState, stepInput } = input;
  let { humanInput, session } = input;
  // Releases before human input owned sign-in callbacks kept them in durable
  // context; only the step that receives a callback hands it to tools now.
  contextStorage.getStore()?.delete(PendingAuthorizationResultKey);
  const host = new PreStepHost({ emit, emissionState });
  const arrivals = humanInput.arrivals({
    callbacks: input.callbacks,
    now: Date.now(),
    sender: input.auth,
    stepInput,
  });
  // `time` comes first, so a candidate that expired never runs its policy.
  for (const arrival of arrivals) {
    const checks = humanInput.policyChecks(arrival);
    const verdicts =
      checks.length === 0 ? undefined : await runPolicyChecks(checks, effects, session);
    const committed = await commitTurn(
      host,
      session,
      verdicts === undefined ? arrival : ({ ...arrival, verdicts } as InputOf<"pre-step">),
    );
    ({ humanInput, session } = committed);
    if (committed.ended !== undefined) return { result: committed.ended };
  }
  let turnInput = host.messageAnswered ? withoutMessage(stepInput) : stepInput;
  if (humanInput.approvedCalls() !== undefined) {
    // The step reports the message it read, though the model never does.
    if (input.received !== undefined) {
      await emit?.(
        createMessageReceivedEvent({
          message: input.received,
          sequence: emissionState.sequence,
          turnId: emissionState.turnId,
        }),
      );
    }
    const ran = await runApprovedStep({
      effects,
      emit,
      emissionState,
      humanInput,
      runStep: input.runStep,
      session,
      turnInput,
    });
    if ("result" in ran) return ran;
    ({ humanInput, session } = ran);
    turnInput = undefined;
  }
  if (humanInput.isWaitingForInput()) {
    // A message that answers nothing still joins history, so it is read once
    // the turn runs again; the wait before the model call keeps it.
    if (turnInput?.message === undefined) {
      return { result: await waitForInput({ emissionState, host, session }) };
    }
    return { humanInput, session, turnInput };
  }
  if (!humanInput.hasQueuedInput()) return { humanInput, session, turnInput };
  const taken = await commitTurn(host, session, { type: "input.resumed" });
  const resumed = host.resumed;
  if (resumed === undefined) {
    return { humanInput: taken.humanInput, session: taken.session, turnInput };
  }
  return {
    humanInput: taken.humanInput,
    resumed,
    session: taken.session,
    turnInput: turnInput === undefined ? resumed : coalesceTurnInputs(resumed, turnInput),
  };
}

/**
 * The session a cancelled turn settles from: `session`, saved before the step
 * that ended it, with what that step closed and reported closed again, so the
 * parked settle doesn't report it a second time. A budget Stop closed its
 * question; a cancel in the step closed the turn's own requests. Otherwise
 * `session` is kept.
 */
export async function settledByEnding(
  session: HarnessSession,
  ending: Ending,
): Promise<HarnessSession> {
  const host = new PreStepHost({ emissionState: getHarnessEmissionState(session.state) });
  if (ending.declined === "budget") {
    const settled = await HumanInput.commit(host, session, {
      requestId: ending.requestId,
      type: "budget.stopped",
    });
    return settled.session;
  }
  if (ending.closed !== "own") return session;
  return (await HumanInput.commit(host, session, { type: "cancel.replayed" })).session;
}

/**
 * The session a turn cancelled mid-step settles from: `session`, saved before
 * the step, with what the step already resolved and published, `resolved`,
 * closed again without publishing it twice.
 */
export async function settledByRollback(
  session: HarnessSession,
  resolved: readonly string[],
): Promise<HarnessSession> {
  if (resolved.length === 0) return session;
  const host = new PreStepHost({ emissionState: getHarnessEmissionState(session.state) });
  return (await HumanInput.commit(host, session, { resolved, type: "step.rolledBack" })).session;
}

/** A message that answered requests isn't turn input, nor is the context sent with it. */
function withoutMessage(input: StepInput | undefined): StepInput | undefined {
  if (input === undefined) return undefined;
  const { context: _context, message: _message, ...rest } = input;
  return rest;
}
