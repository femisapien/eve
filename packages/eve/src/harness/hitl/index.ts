import type { ModelMessage, UserContent } from "ai";
import type { SessionAuthContext } from "#channel/types.js";

import type { SessionStateMap, StepInput } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

import { askedCallIds, grantedApprovalKeys } from "./approval.js";
import { arrivalsOf } from "./input-arrival.js";
import { candidateAuthorizationAttempts } from "./approval-candidate.js";
import type { Next } from "./command.js";
import { approvedCallsOf, heldCalls, type HeldCalls } from "./held-step.js";
import {
  assertPhase,
  EVENT_PHASES,
  INPUT_PHASES,
  publishWaiting,
  type Committed,
  type HostEventOf,
  type HumanInputHost,
  type InputOf,
  type Phase,
  type Stateful,
} from "./host.js";
import type { PolicyCheck, RequestAt } from "./input.js";
import { reduce, verdictsOf } from "./reducer.js";
import { relayedRequestIds } from "./relay.js";
import { awaitedAuthorizations } from "./authorization.js";
import { staleAnswersAsText } from "./input-stale-answer.js";
import { LEGACY_BATCH_KEY, store, type HumanInputState, isOpenRelayed } from "./state.js";
import { readState } from "./state-legacy.js";

export { approvalsRequested, withoutApprovalParts } from "./approval.js";
export { createSessionLimitContinuationRequest } from "./budget-question.js";
export { CANCELLED_CALL_RESULT } from "./held-step.js";
export { runAuthorizationEvent } from "./authorization.js";
export type { HeldCall, HeldCalls } from "./held-step.js";
export type { Command, Next } from "./command.js";
export type {
  Committed,
  Ending,
  EventOrigin,
  HostEvent,
  HostEventOf,
  HumanInputHost,
  InputOf,
  Phase,
} from "./host.js";
export type {
  FromHost,
  FromInbox,
  FromRelay,
  FromStep,
  Input,
  PolicyCheck,
  PolicyRun,
  RelayRoute,
  RequestAt,
  Verdicts,
} from "./input.js";
export { reduceHumanInput } from "./reducer.js";
export type { HumanInputState, Reduced } from "./state.js";

/**
 * Everything a turn waits on from a person: tool approvals, authorizations, the
 * budget question, and requests relayed from child sessions and workflow runs.
 *
 * This is the only module that knows how human input works. The rest of eve
 * commits what happened (`commit`), through a host that carries out what only
 * its phase can, and asks what to do next (`next`). It never reads or changes
 * the state itself, which lives under one session key that only `commit` writes.
 *
 * Words, one meaning each:
 * - **turn**: it *waits* (`{ waiting: "input" }`, `turn.waiting`), on a
 *   person or on runtime work, until it can continue.
 * - **step**: one model call and its tool calls. It is started, then
 *   completed (the model call is done), then *settled* (every call has a
 *   result), and only then joins history.
 * - **held step**: a completed step that has not settled, kept out of
 *   history. There is at most one.
 * - **held call**: a call of the held step that has no result yet.
 * - **request**: something asked of a person; it stays *open* until resolved.
 * - **input**: one thing the session saw at a step boundary (`Input`): from
 *   the step, the inbox, or a relay (a child session or run).
 * - **command**: what the rules tell the host to do (`Command`). An
 *   imperative the host carries out; nothing is reported back.
 */
export class HumanInput {
  readonly #state: HumanInputState;
  /** The session still has a step parked under the coordination batch's old key. */
  readonly #legacy: boolean;

  private constructor(state: HumanInputState, legacy: boolean) {
    this.#state = state;
    this.#legacy = legacy;
  }

  /** Reads the session's human input. */
  static read(sessionState: SessionStateMap | undefined): HumanInput {
    return new HumanInput(readState(sessionState), sessionState?.[LEGACY_BATCH_KEY] !== undefined);
  }

  /**
   * The one way human input changes: runs the rules on what happened, stores
   * the state they leave in `session`, and carries out the events they report,
   * through `host` for the events only its phase can carry out. A host never
   * reports back mid-commit: work the turn runs for a person (approved calls,
   * response policies) runs between commits, and what it did is committed as
   * the next input. Returns the session with its human input, and how the turn ended when an
   * event ended it.
   */
  static async commit<S extends Stateful, P extends Phase>(
    host: HumanInputHost<S, P>,
    session: S,
    input: NoInfer<InputOf<P>>,
  ): Promise<Committed<S>> {
    assertPhase(INPUT_PHASES, input.type, host.phase);
    const reduced = reduce(readState(session.state), input, host.phase, verdictsOf(input));
    let current: S = { ...session, state: store(session.state, reduced.state) };
    for (const event of reduced.events) {
      switch (event.type) {
        case "publish":
          await host.publish(event.event, event.relayed === true ? "relayed" : "own");
          continue;
        case "waitTurn":
          await publishWaiting(host, current, event.relayed === true ? "relayed" : "own");
          continue;
        case "cancelTurn":
          return {
            ending:
              event.closed === "own" ? { closed: "own", kind: "cancelled" } : { kind: "cancelled" },
            session: current,
          };
        // Stop resolved the budget question: the turn ends as cancelled.
        case "declineBudget":
          return {
            ending: { declined: "budget", kind: "cancelled", requestId: event.requestId },
            session: current,
          };
        default: {
          assertPhase(EVENT_PHASES, event.type, host.phase);
          current = await host.carry(event as HostEventOf<P>, current);
        }
      }
    }
    return { session: current };
  }

  /**
   * What the turn does now: run the calls a person approved (`approvedCalls`),
   * then commit what they did as `actions.settled`; run its next model step;
   * or wait. The model never
   * runs while a request of its own is open, authorizations included; a relayed
   * request waits on the call that asked, not on the model.
   */
  next(): Next {
    if (approvedCallsOf(this.#state.held) !== undefined) return { run: "approved" };
    return Object.values(this.#state.requests).some((open) => !isOpenRelayed(open))
      ? { waiting: "input" }
      : { run: "model" };
  }

  /**
   * The input a step runs with, once answers to closed budget questions are
   * dropped and answers to other requests that are no longer open become text
   * the model reads. `displayMessage` is that input's message as the person
   * sent it, for `message.received`.
   */
  acceptInput(input: StepInput | undefined): {
    readonly input: StepInput | undefined;
    readonly displayMessage?: string | UserContent;
  } {
    const open = this.openRequestIds();
    return staleAnswersAsText(input, open);
  }

  /** Whether turn input waits for the turn's next step, behind calls that have joined history. */
  hasQueuedInput(): boolean {
    return this.#state.queued !== undefined;
  }

  /** What arrived for the turn's step, as the inputs to commit, in order. */
  arrivals(
    input: Omit<Parameters<typeof arrivalsOf>[0], "waiting">,
  ): readonly InputOf<"pre-step">[] {
    return arrivalsOf({ ...input, waiting: "waiting" in this.next() });
  }

  /**
   * The held step's messages: the response of a step whose calls wait,
   * held out of history until each has a result. Tools that run for it read
   * them after history.
   */
  heldMessages(): readonly ModelMessage[] {
    return this.#state.held?.messages ?? [];
  }

  /**
   * The model step whose calls wait, out of history: each call without a
   * result, tagged with whether it waits on a person or on runtime work.
   */
  heldCalls(): HeldCalls | undefined {
    return heldCalls(this.#state.held, askedCallIds(this.#state));
  }

  /** The held step's calls that run as runtime work and have no result yet. */
  runtimeCalls(): HeldCalls | undefined {
    const held = this.heldCalls();
    return held?.calls.some((call) => call.waitsOn === "runtime") === true ? held : undefined;
  }

  /** The full auth of whoever approved a request, when it was allowed. */
  approverOfRequest(requestId: string): SessionAuthContext | undefined {
    return this.#state.audit?.settlements[requestId]?.approver;
  }

  /** The calls a person approved that the turn has yet to run, at the step that asked. */
  approvedCalls():
    | { readonly at: RequestAt; readonly requests: readonly InputRequest[] }
    | undefined {
    return approvedCallsOf(this.#state.held);
  }

  /**
   * The response policies to run before `input` is committed: one per
   * candidate it proposes, or readies once its responder authorized. The host
   * runs them and commits `input` with what each did, as `verdicts`. Commit
   * `time` first, so an expired candidate never runs its policy.
   */
  policyChecks(input: InputOf<"pre-step">): readonly PolicyCheck[] {
    if (input.type !== "input.answered" && input.type !== "authorization.completed") return [];
    const checks: PolicyCheck[] = [];
    reduce(this.#state, input, "pre-step", (check) => {
      checks.push(check);
      return undefined;
    });
    return checks;
  }

  /**
   * Whether a model step is held out of history. A step parked under the old
   * coordination key counts even when it can't be read, so nothing treats
   * its session as idle.
   */
  holdsStep(): boolean {
    return this.#state.held !== undefined || this.#legacy;
  }

  /** The approval keys `once()` approvals granted, which approval policies read. */
  grantedApprovalKeys(): ReadonlySet<string> {
    return grantedApprovalKeys(this.#state);
  }

  /** The authorization attempts whose callbacks the turn waits for, its responders' included. */
  awaitedAuthorizations(): readonly string[] {
    return [...awaitedAuthorizations(this.#state), ...candidateAuthorizationAttempts(this.#state)];
  }

  /**
   * Whether the session carries anything for a child or run: a relayed
   * request, or an authorization it started. Ending the run ends what it relayed.
   */
  relaysAnything(): boolean {
    return (
      this.relayedRequestIds().size > 0 ||
      Object.keys(this.#state.relayedAuthorizations ?? {}).length > 0
    );
  }

  /**
   * The ids of the open requests of this session's own that an answer can
   * resolve, for routing an answer to its turn. Authorizations are closed by their
   * callbacks instead, and relayed requests belong to whoever asked.
   */
  openRequestIds(): ReadonlySet<string> {
    return new Set(
      Object.entries(this.#state.requests).flatMap(([requestId, open]) =>
        open.kind === "authorization" || isOpenRelayed(open) ? [] : [requestId],
      ),
    );
  }

  /** Whether the open request is an approval, for attributing its response. */
  isApproval(requestId: string): boolean {
    return this.#state.requests[requestId]?.kind === "tool-approval";
  }

  /** The ids of the open relayed requests, whose answers a delivery may carry to who asked. */
  relayedRequestIds(): ReadonlySet<string> {
    return relayedRequestIds(this.#state);
  }

  /** How a message from the turn's own person steers the turn now. */
  steering(): Steering {
    return {
      interruptsGeneration: this.relayedRequestIds().size === 0,
      overridesQueue: "waiting" in this.next(),
    };
  }
}

/** How a message from the turn's own person steers the turn. */
export interface Steering {
  /**
   * The turn waits on them, so their message steers it whatever its turn
   * policy: queued, it would wait for a turn that can't end until they act.
   */
  readonly overridesQueue: boolean;
  /**
   * Their message may interrupt the model mid-generation. Not while a request
   * relayed through the session is open: the message may answer it, so it
   * waits for the step boundary that forwards it.
   */
  readonly interruptsGeneration: boolean;
}
