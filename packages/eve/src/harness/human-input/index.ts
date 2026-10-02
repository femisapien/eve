import type { ModelMessage, UserContent } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";
import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import {
  answerBudget,
  answerBudgetByText,
  askBudget,
  withdrawBudget,
} from "#harness/human-input/budget.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

import {
  answerApprovals,
  cancelApprovals,
  grantedApprovalKeys,
  openApprovals,
  receiveMessage,
  settleCalls,
  type OpenApproval,
} from "./approvals.js";
import {
  deliverToRelayed,
  isOpenRelayed,
  relay,
  relayedRequestIds,
  withdrawAsk,
  withdrawRelayed,
  type OpenRelayed,
} from "./relayed.js";
import { staleAnswersAsText } from "./stale-answers.js";

/**
 * Everything a turn waits on from a person: tool approvals, sign-ins, the
 * budget question, and requests relayed from child sessions and workflow runs.
 *
 * This is the only module that knows how human input works. The rest of eve
 * reports what happened (`interrupt`, `intake`), applies the events that come
 * back, and asks what to do next (`next`). It never reads or changes the state
 * itself, which lives under one session key that only this module touches.
 */
export class HumanInput {
  readonly #state: HumanInputState;

  private constructor(state: HumanInputState) {
    this.#state = state;
  }

  /** Reads the session's human input. */
  static read(sessionState: SessionStateMap | undefined): HumanInput {
    return new HumanInput(parseState(sessionState?.[STATE_KEY]));
  }

  /** Writes it back, removing the key when nothing is open. */
  write(sessionState: SessionStateMap | undefined): SessionStateMap | undefined {
    const next: Record<string, unknown> = { ...sessionState };
    if (isEmpty(this.#state)) delete next[STATE_KEY];
    else next[STATE_KEY] = this.#state;
    return Object.keys(next).length > 0 ? next : undefined;
  }

  /** The turn needs a person: a model step's calls, the budget, or a child asked. */
  interrupt(interrupt: Interrupt): Transition {
    return this.#apply(reduce(this.#state, interrupt));
  }

  /** Something arrived for the turn: an answer, a message, a cancel, a callback. */
  intake(intake: Intake): Transition {
    return this.#apply(reduce(this.#state, intake));
  }

  /**
   * What the turn does now: run its next model step, or wait. The model never
   * runs while a request of its own is open; a relayed request waits on the
   * call that asked, not on the model.
   */
  next(): Next {
    return this.openRequestIds().size === 0 ? { run: "model" } : { held: "input" };
  }

  /**
   * The input a step runs with, once answers to requests that are no longer
   * open become text the model reads. `displayMessage` is that input's message
   * as the person sent it, for `message.received`.
   */
  acceptInput(input: StepInput | undefined): {
    readonly input: StepInput | undefined;
    readonly displayMessage?: string | UserContent;
  } {
    return staleAnswersAsText(input, this.openRequestIds());
  }

  /** The approval keys `once()` approvals granted, which approval policies read. */
  grantedApprovalKeys(): ReadonlySet<string> {
    return grantedApprovalKeys(this.#state);
  }

  #apply(reduced: Reduced): Transition {
    return { events: reduced.events, humanInput: new HumanInput(reduced.state) };
  }

  /** The ids of the open requests this session answers itself, for routing an answer to its turn. */
  openRequestIds(): ReadonlySet<string> {
    return new Set(
      Object.entries(this.#state.requests).flatMap(([id, open]) =>
        isOpenRelayed(open) ? [] : [id],
      ),
    );
  }

  /** The ids of the open relayed requests, whose answers a delivery may carry to who asked. */
  relayedRequestIds(): ReadonlySet<string> {
    return relayedRequestIds(this.#state);
  }
}

/** The coordinates of the stream position a request was asked at. */
export interface RequestAt {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** What may be asked of the turn. */
export type Interrupt =
  /** A model step made calls whose approval policy asks a person. */
  | {
      readonly type: "approvals.requested";
      readonly at: RequestAt;
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
      readonly callIds: readonly string[];
      readonly challenges: readonly AuthorizationChallenge[];
      readonly requester: SessionAuthContext | null;
    }
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
    };

/** What may arrive for the turn. */
export type Intake =
  | {
      readonly type: "answered";
      readonly responses: readonly InputResponse[];
      readonly responder: SessionAuthContext | null;
    }
  /** A message; from the person who started the turn, it steers it. */
  | {
      readonly type: "message";
      readonly text: string;
      readonly sender: SessionAuthContext | null;
    }
  | { readonly type: "cancelled" }
  | {
      readonly type: "authorization.completed";
      readonly attemptId: string;
      readonly outcome: "authorized" | "failed";
    }
  /** The runtime ran a response policy that `responder.check` asked for. */
  | {
      readonly type: "responder.checked";
      readonly candidateId: string;
      readonly verdict: "allowed" | "rejected" | "failed" | "authorization-required";
    }
  /** The runtime ran the calls `calls.approved` asked for. */
  | { readonly type: "calls.settled"; readonly results: readonly ModelMessage[] }
  | { readonly type: "time"; readonly now: number }
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
  /** The message answered open requests, so the turn doesn't read it as input. */
  | { readonly type: "message.answered" }
  /** Run a response policy for this answer; report `responder.checked`. */
  | { readonly type: "responder.check"; readonly candidateId: string; readonly requestId: string }
  /** Deliver these answers to the child session, remote agent, or run that asked. */
  | {
      readonly type: "answer.forwarded";
      readonly route: RelayRoute;
      readonly responses: readonly InputResponse[];
    }
  /** Tell a run, on its control hook, that its `ctx.ask()` question is withdrawn. */
  | { readonly type: "question.withdrawn"; readonly control: string; readonly requestId: string }
  /** The turn waits on a person while the call that asked keeps running: publish `turn.waiting`. */
  | { readonly type: "turn.held" }
  /** Grant a fresh budget window: the person chose to continue. */
  | { readonly type: "budget.granted" }
  /** The person chose to stop: the budget question is resolved; cancel the turn. */
  | { readonly type: "budget.declined"; readonly requestId: string }
  /** Tell the model something with the turn's next input. */
  | { readonly type: "note"; readonly text: string }
  | { readonly type: "turn.cancelled" }
  | { readonly type: "turn.failed"; readonly code: string; readonly message: string };

export interface Transition {
  readonly humanInput: HumanInput;
  readonly events: readonly HumanInputEvent[];
}

export type Next = { readonly run: "model" } | { readonly held: "input" };

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

/** Exported only for the rules files beside this one. */
export interface HumanInputState {
  /** Every open request, by `requestId`. */
  readonly requests: Readonly<Record<string, OpenRequest>>;
  /** Input that arrived before it could run: a partial answer, or a message behind one. */
  readonly queued?: StepInput;
  /** Approval keys a `once()` approval granted for the rest of the session. */
  readonly grants: readonly string[];
}

type OpenRequest =
  | OpenApproval
  | {
      readonly kind: "authorization";
      readonly at: RequestAt;
      readonly callIds: readonly string[];
      readonly challenge: AuthorizationChallenge;
      readonly requester: SessionAuthContext | null;
    }
  | { readonly kind: "session-limit"; readonly at: RequestAt; readonly request: InputRequest }
  | OpenRelayed;

const EMPTY: HumanInputState = { grants: [], requests: {} };

function parseState(value: unknown): HumanInputState {
  if (typeof value !== "object" || value === null) return EMPTY;
  const requests: unknown = Reflect.get(value, "requests");
  const grants: unknown = Reflect.get(value, "grants");
  if (typeof requests !== "object" || requests === null || !Array.isArray(grants)) return EMPTY;
  return value as HumanInputState;
}

function isEmpty(state: HumanInputState): boolean {
  return (
    Object.keys(state.requests).length === 0 &&
    state.queued === undefined &&
    state.grants.length === 0
  );
}

// ---------------------------------------------------------------------------
// The rules: one reducer, (state, input) -> (state, events).
// ---------------------------------------------------------------------------

interface Reduced {
  readonly events: readonly HumanInputEvent[];
  readonly state: HumanInputState;
}

function reduce(state: HumanInputState, input: Interrupt | Intake): Reduced {
  switch (input.type) {
    case "budget.exceeded":
      return askBudget(state, input);
    case "approvals.requested":
      // Response policies decide who may answer; they come back in a later change.
      if (input.responsePolicyRequestIds.length > 0) {
        return unavailable(
          state,
          "This turn needs an approval whose tool defines an `approval.response` policy, which eve cannot ask for yet.",
        );
      }
      return openApprovals(state, input);
    case "answered": {
      const budget = answerBudget(state, input.responses);
      const approvals = answerApprovals(budget.state, budget.unclaimed);
      return { events: [...budget.events, ...approvals.events], state: approvals.state };
    }
    // A typed reply answers the budget question when it names one of its
    // options; otherwise it is for the approvals.
    case "message":
      return answerBudgetByText(state, input.text) ?? receiveMessage(state, input.text);
    case "cancelled": {
      // The cancel stops every child and run, so nobody can answer what they relayed.
      const relayed = withdrawRelayed(state);
      const budget = withdrawBudget(relayed.state);
      const approvals = cancelApprovals(budget.state);
      return {
        events: [...relayed.events, ...budget.events, ...approvals.events],
        state: approvals.state,
      };
    }
    case "relayed.requested":
      return relay(state, input);
    case "delivered":
      return deliverToRelayed(state, input);
    case "run.ended":
      return withdrawRelayed(state, (open) => open.route.runId === input.runId);
    case "withdraw.requested":
      return withdrawAsk(state, input);
    case "calls.settled":
      return settleCalls(state, input.results);
    // Human input is being rebuilt case by case. Until a case exists, a turn
    // that needs a person fails with a clear error instead of hanging.
    case "authorization.required":
      return unavailable(
        state,
        `This turn needs a person (${input.type}), which eve cannot ask for yet.`,
      );
    case "authorization.completed":
    case "responder.checked":
    case "time":
      return { events: [], state };
    default: {
      const unhandled: never = input;
      throw new TypeError(`Unhandled human input: ${JSON.stringify(unhandled)}`);
    }
  }
}

function unavailable(state: HumanInputState, message: string): Reduced {
  return { events: [{ code: "HUMAN_INPUT_UNAVAILABLE", message, type: "turn.failed" }], state };
}
