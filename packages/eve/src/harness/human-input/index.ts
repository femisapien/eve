import type { ModelMessage, UserContent } from "ai";

import type { SessionAuthContext, SubagentAuthorizationEvent } from "#channel/types.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";
import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { AuthorizationChallenge, AuthorizationResult } from "#harness/authorization.js";
import {
  answerBudget,
  answerBudgetByText,
  askBudget,
  stopBudget,
  withdrawBudget,
  withoutClosedBudgetAnswers,
} from "#harness/human-input/budget.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import { createTurnWaitingEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { AuthorizationCallback } from "#shared/connection-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { TokenUsage } from "#shared/token-usage.js";

import {
  answerApprovals,
  answerApprovalsByText,
  askedCallIds,
  cancelApprovals,
  grantedApprovalKeys,
  isPolicyGated,
  openApprovals,
  settleCalls,
  steerPastApprovals,
  type OpenApproval,
} from "./approvals.js";
import {
  adoptCandidateSignIns,
  candidateSignInAttempts,
  checkedCandidate,
  completeCandidateSignIn,
  expireCandidates,
  proposeCandidates,
  staleCandidates,
  type ApprovalAudit,
  type CandidateDecision,
} from "./candidates.js";
import {
  awaitedSignIns,
  closeSignIns,
  completeSignIn,
  openSignIns,
  requireSignIns,
  type OpenSignIn,
} from "./sign-ins.js";
import {
  deliverToRelayed,
  endRelayedSignIns,
  isOpenRelayed,
  relay,
  relayAuthorization,
  relayedRequestIds,
  withdrawAsk,
  withdrawRelayed,
  type OpenRelayed,
  type RelayedSignIn,
} from "./relayed.js";
import { staleAnswersAsText } from "./stale-answers.js";
import {
  cancelStep,
  dispatchCalls,
  hasApprovedCalls,
  heldStep,
  runApproved,
  withMessages,
  type HeldStep,
  type SuspendedStep,
} from "./suspended-step.js";
import { arrivalsOf } from "./arrivals.js";

export { approvalsRequested, withoutApprovalParts } from "./approvals.js";
export { createSessionLimitContinuationRequest } from "./budget-question.js";
export { CANCELLED_CALL_RESULT } from "./suspended-step.js";
export type { HeldCall, HeldStep } from "./suspended-step.js";

/**
 * Everything a turn waits on from a person: tool approvals, sign-ins, the
 * budget question, and requests relayed from child sessions and workflow runs.
 *
 * This is the only module that knows how human input works. The rest of eve
 * commits what happened (`commit`), through a host that carries out what only
 * its phase can, and asks what to do next (`next`). It never reads or changes
 * the state itself, which lives under one session key that only `commit` writes.
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
   * through `host` for the events only its phase can carry out. What a host
   * reports back, such as an approved call's result, is committed the same way.
   * Returns the session with its human input, and how the turn ended when an
   * event ended it.
   */
  static async commit<S extends Stateful>(
    host: HumanInputHost<S>,
    session: S,
    input: Interrupt | Intake,
  ): Promise<Committed<S>> {
    const reduced = reduce(readState(session.state), input);
    let current: S = { ...session, state: store(session.state, reduced.state) };
    for (const event of reduced.events) {
      switch (event.type) {
        case "publish":
          await host.publish(event.event, event.relayed === true ? "relayed" : "own");
          continue;
        case "turn.held":
          await publishWaiting(host, current, event.relayed === true ? "relayed" : "own");
          continue;
        case "turn.cancelled":
          return { ending: { kind: "cancelled" }, session: current };
        // Stop resolved the budget question: the turn ends as cancelled.
        case "budget.declined":
          return {
            ending: { declined: "budget", kind: "cancelled", requestId: event.requestId },
            session: current,
          };
        default: {
          const carried = await host.carry(event, current);
          current = carried.session;
          for (const reported of carried.report ?? []) {
            const nested = await HumanInput.commit(host, current, reported);
            current = nested.session;
            if (nested.ending !== undefined) return nested;
          }
        }
      }
    }
    return { session: current };
  }

  /**
   * What the turn does now: run the calls a person approved, as a step
   * without a model call; run its next model step; or wait. The model never
   * runs while a request of its own is open, sign-ins included; a relayed
   * request waits on the call that asked, not on the model.
   */
  next(): Next {
    if (hasApprovedCalls(this.#state.suspended)) return { run: "calls" };
    return Object.values(this.#state.requests).some((open) => !isOpenRelayed(open))
      ? { held: "input" }
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
    return staleAnswersAsText(withoutClosedBudgetAnswers(input, open), open);
  }

  /** What arrived for the turn's step, as the intakes to hand to `intake`, in order. */
  arrivals(input: Omit<Parameters<typeof arrivalsOf>[0], "held">): readonly Intake[] {
    return arrivalsOf({ ...input, held: "held" in this.next() });
  }

  /**
   * The suspended step's messages: the response of a step whose calls wait,
   * held out of history until each has a result. Tools that run for it read
   * them after history.
   */
  suspendedMessages(): readonly ModelMessage[] {
    return this.#state.suspended?.messages ?? [];
  }

  /**
   * The model step whose calls wait, out of history: each call without a
   * result, tagged with whether it waits on a person or on runtime work.
   */
  heldStep(): HeldStep | undefined {
    return heldStep(this.#state.suspended, askedCallIds(this.#state));
  }

  /** The suspended step's calls that run as runtime work and have no result yet. */
  runtimeCalls(): HeldStep | undefined {
    const held = this.heldStep();
    return held?.calls.some((call) => call.waitsOn === "runtime") === true ? held : undefined;
  }

  /**
   * Whether a model step is held out of history. A step parked under the old
   * coordination key counts even when it can't be read, so nothing treats
   * its session as idle.
   */
  holdsStep(): boolean {
    return this.#state.suspended !== undefined || this.#legacy;
  }

  /** The approval keys `once()` approvals granted, which approval policies read. */
  grantedApprovalKeys(): ReadonlySet<string> {
    return grantedApprovalKeys(this.#state);
  }

  /** The sign-in attempts whose callbacks the turn waits for, its responders' included. */
  awaitedSignIns(): readonly string[] {
    return [...awaitedSignIns(this.#state), ...candidateSignInAttempts(this.#state)];
  }

  /**
   * Whether the session carries anything for a child or run: a relayed
   * request, or a sign-in it started. Ending the run ends what it relayed.
   */
  relaysAnything(): boolean {
    return (
      this.relayedRequestIds().size > 0 || Object.keys(this.#state.relayedSignIns ?? {}).length > 0
    );
  }

  /**
   * The ids of the open requests of this session's own that an answer can
   * resolve, for routing an answer to its turn. Sign-ins are closed by their
   * callbacks instead, and relayed requests belong to whoever asked.
   */
  openRequestIds(): ReadonlySet<string> {
    return new Set(
      Object.entries(this.#state.requests).flatMap(([requestId, open]) =>
        open.kind === "authorization" || isOpenRelayed(open) ? [] : [requestId],
      ),
    );
  }

  /** The ids of the open relayed requests, whose answers a delivery may carry to who asked. */
  relayedRequestIds(): ReadonlySet<string> {
    return relayedRequestIds(this.#state);
  }
}

/**
 * The rules alone: the session state `input` leaves and the events it
 * reports, with nothing carried out. Only rule tests call this; the runtime
 * commits.
 */
export function reduceHumanInput(
  sessionState: SessionStateMap | undefined,
  input: Interrupt | Intake,
): { readonly events: readonly HumanInputEvent[]; readonly state: SessionStateMap | undefined } {
  const reduced = reduce(readState(sessionState), input);
  return { events: reduced.events, state: store(sessionState, reduced.state) };
}

type Stateful = { readonly state?: SessionStateMap };

/** Whose exchange an event belongs to: the session's own, or one it relays for a child or run. */
export type EventOrigin = "own" | "relayed";

/** The events `commit` carries out itself, for every host. */
type CommittedEvent = "publish" | "turn.held" | "turn.cancelled" | "budget.declined";

/** The events a host carries out: those that need what only its phase has. */
export type HostEvent = Exclude<HumanInputEvent, { readonly type: CommittedEvent }>;

/**
 * Where human input is committed: the turn's steps before and after a model
 * call, and the session steps around a parked turn. A host carries out what
 * only its phase can, such as running an approved call, and reports back.
 */
export interface HumanInputHost<S extends Stateful> {
  publish(event: UnstampedMessageStreamEvent, origin: EventOrigin): Promise<void>;
  /** The step a `turn.waiting` reports at, and the session's usage. */
  waitingAt(session: S): {
    readonly sequence: number;
    readonly turnId: string;
    readonly usage?: TokenUsage;
  };
  carry(event: HostEvent, session: S): Promise<Carried<S>>;
}

/** What carrying out an event left: the session, and what to commit next, in order. */
export interface Carried<S> {
  readonly session: S;
  readonly report?: readonly (Interrupt | Intake)[];
}

/** How human input ended the turn: cancelled, or by a Stop at the budget question. */
export type Ending =
  | { readonly kind: "cancelled"; readonly declined?: undefined }
  | { readonly kind: "cancelled"; readonly declined: "budget"; readonly requestId: string };

export interface Committed<S> {
  readonly session: S;
  readonly ending?: Ending;
}

/** The coordinates of the stream position a request was asked at. */
export interface RequestAt {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** What may be asked of the turn. */
export type Interrupt =
  /**
   * The turn stops to wait on a person: before its model call, or after a
   * step whose calls asked one. It resumes in the same turn once the person
   * answers, steers, or cancels.
   */
  | { readonly type: "turn.holding" }
  /** A model step made calls whose approval policy asks a person. */
  | {
      readonly type: "approvals.requested";
      readonly at: RequestAt;
      /** The step's response, which waits out of history until every call it made has a result. */
      readonly messages: readonly ModelMessage[];
      readonly requests: readonly InputRequest[];
      readonly requester: SessionAuthContext | null;
      /** Each request's approval key (the tool's `approvalKey`), when its tool has one. */
      readonly approvalKeys: Readonly<Record<string, string>>;
      /** Requests whose tool decides who may answer (`approval.response`). */
      readonly responsePolicyRequestIds: readonly string[];
    }
  /** A tool call needs a sign-in before it can run. */
  | {
      readonly type: "authorization.required";
      readonly at: RequestAt;
      /** The calls that asked; the model calls them again once signed in. */
      readonly callIds: readonly string[];
      /**
       * The step's response. It joins history without the calls that asked,
       * so history never holds a call that waits on a person, unless the
       * step is suspended: then the calls leave the suspended step.
       */
      readonly messages: readonly ModelMessage[];
      readonly challenges: readonly AuthorizationChallenge[];
      readonly requester: SessionAuthContext | null;
    }
  /**
   * Some of a model step's calls run as runtime work: workflow runs, agents,
   * and task tool calls. The step waits out of history for their results.
   */
  | {
      readonly type: "calls.dispatched";
      readonly at: RequestAt;
      /** The step's response; see `approvals.requested`. */
      readonly messages: readonly ModelMessage[];
      /** The workflow runs they start. */
      readonly tasks: readonly RuntimeWorkflowTaskRequest[];
    }
  /**
   * The turn runs the calls a person approved, as a step without a model
   * call. `following` is the turn input that arrived with the answers: the
   * turn reads it once the step joins history.
   */
  | { readonly type: "approved.run"; readonly following?: StepInput }
  /** The budget ran out before a model call, and a person can grant more. */
  | {
      readonly type: "budget.exceeded";
      readonly at: RequestAt;
      readonly request: InputRequest;
    }
  /**
   * A child session, remote agent, or workflow run asks a person, through this
   * session. `at` is the child batch's coordinates.
   */
  | {
      readonly type: "relayed.requested";
      readonly at: RequestAt;
      readonly requests: readonly InputRequest[];
      readonly route: RelayRoute;
      /** The task whose run asked, so readers attach the batch to it. */
      readonly taskId?: string;
    }
  /**
   * A child session or workflow run signs in, or reports its responders'
   * approval candidates, through this session. The child completes its own
   * sign-in on its callback; the session carries the exchange and records each
   * sign-in until it completes.
   */
  | {
      readonly type: "relayed.authorization";
      readonly event: SubagentAuthorizationEvent;
      /** The child session or run that asked; nobody completes its sign-in once it ends. */
      readonly runId: string;
    };

/** What may arrive for the turn. */
export type Intake =
  | {
      readonly type: "answered";
      readonly responses: readonly InputResponse[];
      readonly responder: SessionAuthContext | null;
      /** When the answers arrived, which starts a candidate's time to live. */
      readonly now: number;
    }
  /** A message; from the person who started the turn, it steers it. */
  | {
      readonly type: "message";
      readonly text: string;
      readonly sender: SessionAuthContext | null;
    }
  | { readonly type: "cancelled" }
  /** A sign-in's callback arrived; `failed` when it couldn't be read. */
  | {
      readonly type: "authorization.completed";
      readonly attemptId: string;
      readonly callback?: AuthorizationCallback;
      readonly connectionName: string;
      readonly outcome: "authorized" | "failed";
    }
  /** The runtime ran a response policy that `responder.check` asked for. */
  | {
      readonly type: "responder.checked";
      readonly candidateId: string;
      readonly ran: PolicyRun;
    }
  /**
   * Calls of the suspended step settled: those `calls.approved` asked for, or
   * its runtime calls. `running` is the approved calls that still run as
   * runtime work; `signIns` the approved calls that asked for a sign-in,
   * which leave the step as their sign-ins open.
   */
  | {
      readonly type: "calls.settled";
      readonly results: readonly ModelMessage[];
      readonly running?: readonly RuntimeWorkflowTaskRequest[];
      readonly signIns?: {
        readonly callIds: readonly string[];
        readonly challenges: readonly AuthorizationChallenge[];
      };
    }
  | { readonly type: "time"; readonly now: number }
  /**
   * The turn a budget Stop ended settles as cancelled, from before the step
   * that read the Stop: its budget question is closed, and its resolution
   * was already published.
   */
  | { readonly type: "budget.stopped"; readonly requestId: string }
  /** A workflow run or child session ended; nobody can answer what it relayed. */
  | { readonly type: "run.ended"; readonly runId: string }
  /**
   * A delivery reached the session outside its turn's model steps: while the
   * turn waits on the calls that asked, or between turns. Only relayed
   * requests take from it; the runtime keeps the rest for the turn.
   */
  | {
      readonly type: "delivered";
      readonly responses: readonly InputResponse[];
      /** Its message as text, and whether a delegating caller sent it rather than a person. */
      readonly message?: { readonly text: string; readonly delegated: boolean };
    }
  /** A workflow run asks to withdraw its `ctx.ask()` question `requestId`. */
  | {
      readonly type: "withdraw.requested";
      readonly control: string;
      readonly requestId: string;
      readonly runId: string;
    };

/**
 * What happened. Each has one meaning for the runtime, which applies it and
 * decides nothing: publish an event, append to history, run work and report
 * back through `intake`, or end the turn.
 */
export type HumanInputEvent =
  | {
      readonly type: "publish";
      readonly event: UnstampedMessageStreamEvent;
      /** It belongs to an exchange this session relays for a child or run: publish it as relayed. */
      readonly relayed?: true;
    }
  | { readonly type: "history.appended"; readonly message: ModelMessage }
  /**
   * Run these approved calls with the tools of the step that asked, at its
   * coordinates; report `calls.settled` with their results.
   */
  | {
      readonly type: "calls.approved";
      readonly at: RequestAt;
      readonly requests: readonly InputRequest[];
    }
  /** The suspended step joined history: the turn reads the input that waited behind its calls. */
  | { readonly type: "input.resumed"; readonly input: StepInput }
  /** The message answered open requests, so the turn doesn't read it as input. */
  | { readonly type: "message.answered" }
  /**
   * Run the response policy of `request`'s tool, with the tools of the step
   * that asked, for this responder's decision; report `responder.checked`.
   */
  | {
      readonly type: "responder.check";
      readonly at: RequestAt;
      readonly candidateId: string;
      readonly decision: CandidateDecision;
      readonly request: InputRequest;
      readonly requester: SessionAuthContext | null;
      readonly responder: SessionAuthContext;
    }
  /**
   * A sign-in completed: hand its callback to the tool call or policy that
   * asked, and run as `requester` when one is given.
   */
  | {
      readonly type: "sign-in.completed";
      readonly result: AuthorizationResult & { readonly name: string };
      readonly requester: SessionAuthContext | null;
    }
  /** Deliver these answers to the child session, remote agent, or run that asked. */
  | {
      readonly type: "answer.forwarded";
      readonly route: RelayRoute;
      readonly responses: readonly InputResponse[];
    }
  /** Tell a run, on its control hook, that its `ctx.ask()` question is withdrawn. */
  | { readonly type: "question.withdrawn"; readonly control: string; readonly requestId: string }
  /**
   * The turn waits on a person: publish `turn.waiting`. A relayed hold waits
   * on the call that asked, which keeps running.
   */
  | { readonly type: "turn.held"; readonly relayed?: true }
  /** Grant a fresh budget window: the person chose to continue. */
  | { readonly type: "budget.granted" }
  /** The person chose to stop: the budget question is resolved; cancel the turn. */
  | { readonly type: "budget.declined"; readonly requestId: string }
  /** Tell the model something with the turn's next input. */
  | { readonly type: "note"; readonly text: string }
  | { readonly type: "turn.cancelled" };

export type Next =
  | { readonly run: "model" }
  /** Run the approved calls of the suspended step: `approved.run`, post-step. */
  | { readonly run: "calls" }
  | { readonly held: "input" };

/** What running a response policy did, before human input reads it as a verdict. */
export type PolicyRun =
  /** The tool no longer defines a response policy. */
  | { readonly kind: "missing" }
  | {
      readonly kind: "returned";
      readonly value: { readonly status: string; readonly reason?: string };
    }
  /** It threw or timed out; `challenges` when it threw for the responder to sign in. */
  | { readonly kind: "threw"; readonly challenges?: readonly AuthorizationChallenge[] };

/** Where a relayed request's answer goes. */
export interface RelayRoute {
  /** The child's continuation token, which names its session inbox unless `childSessionInbox` does. */
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  /** A remote agent's session, answered over its own protocol. */
  readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
  /** Where in the child the batch came from; its fresh batch from one source replaces the last. */
  readonly inputSource?: string;
  /** The workflow run that relayed it: nobody can answer it once that run ends. */
  readonly runId?: string;
  /** The run's control hook, for its own `ctx.ask()` question. */
  readonly control?: string;
}

// ---------------------------------------------------------------------------
// State: one session key, read and written only here.
// ---------------------------------------------------------------------------

const STATE_KEY = "eve.harness.humanInput";
/** Where sessions parked before the suspended step held runtime calls kept them. */
const LEGACY_BATCH_KEY = "eve.runtime.pendingCoordinationBatch";

/** Exported only for the rules files beside this one. */
export interface HumanInputState {
  /** Every open request, by `requestId`. */
  readonly requests: Readonly<Record<string, OpenRequest>>;
  /** Input that arrived before it could run: a partial answer, or a message behind one. */
  readonly queued?: StepInput;
  /** Approval keys a `once()` approval granted for the rest of the session. */
  readonly grants: readonly string[];
  /** The model step whose calls wait, held out of history. */
  readonly suspended?: SuspendedStep;
  /** Every response-policy candidate and settlement of the session. */
  readonly audit?: ApprovalAudit;
  /** Sign-ins children and runs started through this session, by attempt id, until they complete. */
  readonly relayedSignIns?: Readonly<Record<string, RelayedSignIn>>;
}

type OpenRequest =
  | OpenApproval
  | OpenSignIn
  | { readonly kind: "session-limit"; readonly at: RequestAt; readonly request: InputRequest }
  | OpenRelayed;

const EMPTY: HumanInputState = { grants: [], requests: {} };

/**
 * The session's human input. A session parked on runtime calls before the
 * suspended step held them has them under the old coordination key, with its
 * response there: they become the suspended step, which its approvals' step
 * already was when it had any.
 */
function readState(sessionState: SessionStateMap | undefined): HumanInputState {
  const state = parseState(sessionState?.[STATE_KEY]);
  const legacy = parseLegacyBatch(sessionState?.[LEGACY_BATCH_KEY]);
  if (legacy === undefined) return state;
  const { suspended } = state;
  const step: SuspendedStep = {
    at: suspended?.at ?? legacy.event,
    messages: withMessages(legacy.responseMessages, suspended?.messages ?? []),
    runtime: { tasks: [...(suspended?.runtime?.tasks ?? []), ...legacy.tasks] },
    ...(legacy.followingInput !== undefined && { following: legacy.followingInput }),
  };
  return { ...state, suspended: step };
}

interface LegacyBatch {
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly event: RequestAt;
  readonly responseMessages: readonly ModelMessage[];
  readonly followingInput?: StepInput;
}

function parseLegacyBatch(value: unknown): LegacyBatch | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const batch = value as LegacyBatch;
  if (
    !Array.isArray(batch.tasks) ||
    !Array.isArray(batch.responseMessages) ||
    typeof batch.event !== "object" ||
    batch.event === null
  ) {
    return undefined;
  }
  return batch;
}

function parseState(value: unknown): HumanInputState {
  if (typeof value !== "object" || value === null) return EMPTY;
  const requests: unknown = Reflect.get(value, "requests");
  const grants: unknown = Reflect.get(value, "grants");
  if (typeof requests !== "object" || requests === null || !Array.isArray(grants)) return EMPTY;
  // Responders' sign-ins were once requests of their own.
  return adoptCandidateSignIns(value as HumanInputState);
}

/**
 * Publishes `turn.waiting` at the step `host` holds at: the only place a turn
 * reports it waits on input.
 */
async function publishWaiting<S extends Stateful>(
  host: HumanInputHost<S>,
  session: S,
  origin: EventOrigin,
): Promise<void> {
  const at = host.waitingAt(session);
  await host.publish(
    createTurnWaitingEvent({
      on: "input",
      sequence: at.sequence,
      turnId: at.turnId,
      usage: at.usage,
    }),
    origin,
  );
}

/** Stores `state` in the session's state, removing the key when nothing is open. */
function store(
  sessionState: SessionStateMap | undefined,
  state: HumanInputState,
): SessionStateMap | undefined {
  const next: Record<string, unknown> = { ...sessionState };
  // `readState` moved a legacy batch into `state`.
  delete next[LEGACY_BATCH_KEY];
  if (isEmpty(state)) delete next[STATE_KEY];
  else next[STATE_KEY] = state;
  return Object.keys(next).length > 0 ? next : undefined;
}

function isEmpty(state: HumanInputState): boolean {
  return (
    Object.keys(state.requests).length === 0 &&
    state.queued === undefined &&
    state.suspended === undefined &&
    state.grants.length === 0 &&
    state.audit === undefined &&
    Object.keys(state.relayedSignIns ?? {}).length === 0
  );
}

// ---------------------------------------------------------------------------
// The rules: one reducer, (state, input) -> (state, events).
// ---------------------------------------------------------------------------

interface Reduced {
  readonly events: readonly HumanInputEvent[];
  readonly state: HumanInputState;
}

const STEERED_REASON = "Cancelled because a new message arrived.";
const CANCELLED_REASON = "Cancelled.";

function reduce(state: HumanInputState, input: Interrupt | Intake): Reduced {
  switch (input.type) {
    case "budget.exceeded":
      return askBudget(state, input);
    case "approvals.requested":
      return openApprovals(state, input);
    case "authorization.required":
      return requireSignIns(state, input);
    case "answered": {
      const budget = answerBudget(state, input.responses);
      const gated = budget.unclaimed.filter((response) =>
        isPolicyGated(budget.state, response.requestId),
      );
      const plain = budget.unclaimed.filter((response) => !gated.includes(response));
      return then(
        budget,
        (next) => proposeCandidates(next, { ...input, responses: gated }),
        (next) => answerApprovals(next, plain),
      );
    }
    // A typed reply answers the budget question or approvals when it names one
    // of their options; any other message steers the turn past everything it
    // waits on.
    case "message":
      return (
        answerBudgetByText(state, input.text) ??
        answerApprovalsByText(state, input.text) ??
        steer(state)
      );
    case "cancelled":
      // Candidates go first: their events report at their approval's coordinates.
      // The cancel stops every child and run, so nobody can answer what they relayed.
      return then(
        staleCandidates(state, CANCELLED_REASON),
        (next) => withdrawRelayed(next),
        (next) => endRelayedSignIns(next),
        withdrawBudget,
        cancelApprovals,
        cancelStep,
        (next) => closeSignIns(next, { outcome: "declined", reason: CANCELLED_REASON }),
      );
    case "relayed.requested":
      return relay(state, input);
    case "relayed.authorization":
      return relayAuthorization(state, input);
    case "turn.holding":
      return { events: [{ type: "turn.held" }], state };
    case "budget.stopped":
      return stopBudget(state, input.requestId);
    case "delivered":
      return deliverToRelayed(state, input);
    case "run.ended":
      return then(
        withdrawRelayed(state, (open) => open.route.runId === input.runId),
        (next) => endRelayedSignIns(next, input.runId),
      );
    case "withdraw.requested":
      return withdrawAsk(state, input);
    case "calls.dispatched":
      return { events: [], state: dispatchCalls(state, input) };
    case "approved.run":
      return runApproved(state, input.following);
    case "calls.settled": {
      const { signIns } = input;
      const at = state.suspended?.at;
      const settled = settleCalls(state, input.results, input.running, signIns?.callIds);
      if (signIns === undefined || at === undefined) return settled;
      // The approved calls that asked for a sign-in left the step; their
      // sign-ins open at the step that asked, and the turn holds on them.
      return then(settled, (next) =>
        openSignIns(next, { at, challenges: signIns.challenges, requester: null }),
      );
    }
    // A callback for an attempt no longer open completes nothing.
    case "authorization.completed":
      return (
        completeSignIn(state, input) ??
        completeCandidateSignIn(state, input) ?? { events: [], state }
      );
    case "responder.checked": {
      const checked = checkedCandidate(state, input);
      const { settled } = checked;
      return settled === undefined
        ? checked
        : then(checked, (next) => answerApprovals(next, [settled]));
    }
    case "time":
      return expireCandidates(state, input.now);
    default: {
      const unhandled: never = input;
      throw new TypeError(`Unhandled human input: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * A message that answers nothing moves the turn on: its approvals resolve,
 * their candidates go stale, and its sign-ins are declined. The model hears
 * which of its sign-ins ended, so it asks again only if still needed.
 */
function steer(state: HumanInputState): Reduced {
  const approvals = then(staleCandidates(state, STEERED_REASON), steerPastApprovals);
  const signIns = closeSignIns(approvals.state, { outcome: "declined", reason: STEERED_REASON });
  const events = [...approvals.events, ...signIns.events];
  if (signIns.names.length > 0) {
    events.push({
      text: `Sign-in to ${signIns.names.join(", ")} was cancelled because the user sent a new message instead. Ask to sign in again only if the new message still needs it.`,
      type: "note",
    });
  }
  return { events, state: signIns.state };
}

/** Runs rules in order, each on the state the last one left, collecting their events. */
function then(first: Reduced, ...rest: ((state: HumanInputState) => Reduced)[]): Reduced {
  let state = first.state;
  const events = [...first.events];
  for (const rule of rest) {
    const reduced = rule(state);
    events.push(...reduced.events);
    state = reduced.state;
  }
  return { events, state };
}
