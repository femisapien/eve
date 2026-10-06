import type { ModelMessage } from "ai";

import type { SessionAuthContext, SubagentAuthorizationEvent } from "#channel/types.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";
import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import type { AuthorizationChallenge, AuthorizationResult } from "#harness/authorization.js";
import type { StepInput } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { AuthorizationCallback } from "#shared/connection-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

/** The coordinates of the stream position a request was asked at. */
export interface RequestAt {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** One thing the session saw at a step boundary, by where it came from. */
export type Input = FromStep | FromInbox | FromRelay | FromHost;

/**
 * What the turn's step saw: a model step's calls asked a person or started
 * runtime work, the budget ran out before a model call, or calls of the held
 * step got their results.
 */
export type FromStep =
  /** A model step made calls whose approval policy asks a person. */
  | {
      readonly type: "approval.requested";
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
  /** A tool call needs an authorization before it can run. */
  | {
      readonly type: "authorization.required";
      readonly at: RequestAt;
      /** The calls that asked; the model calls them again once authorized. */
      readonly callIds: readonly string[];
      /**
       * The step's response. It joins history without the calls that asked,
       * so history never holds a call that waits on a person, unless the
       * step is held: then the calls leave the held step.
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
      readonly type: "actions.dispatched";
      readonly at: RequestAt;
      /** The step's response; see `approval.requested`. */
      readonly messages: readonly ModelMessage[];
      /** The workflow runs they start. */
      readonly tasks: readonly RuntimeWorkflowTaskRequest[];
    }
  /** The budget ran out before a model call, and a person can grant more. */
  | {
      readonly type: "budget.exceeded";
      readonly at: RequestAt;
      readonly request: InputRequest;
    }
  /**
   * Calls of the held step settled: the approved calls the turn ran
   * (`approved`), or its runtime calls. `running` is the approved calls that still run as
   * runtime work; `authorizations` the approved calls that asked for an authorization,
   * which leave the step as their authorizations open.
   */
  | {
      readonly type: "actions.settled";
      readonly results: readonly ModelMessage[];
      readonly running?: readonly RuntimeWorkflowTaskRequest[];
      readonly authorizations?: {
        readonly callIds: readonly string[];
        readonly challenges: readonly AuthorizationChallenge[];
      };
      /**
       * The turn ran the step's approved calls (`approvedCalls`). `following`
       * is the turn input that arrived with their answers: the turn reads it
       * once the step joins history.
       */
      readonly approved?: { readonly following?: StepInput };
    };

/**
 * What arrived for the turn at a step boundary: answers, messages, authorization
 * callbacks, a cancel, a cleared context, and the clock.
 */
export type FromInbox =
  /** Answers to open requests, from `responder`. */
  | {
      readonly type: "input.answered";
      /** What the response policy of each of its `policyChecks` did. */
      readonly verdicts?: Verdicts;
      readonly responses: readonly InputResponse[];
      readonly responder: SessionAuthContext | null;
      /** When the answers arrived, which starts a candidate's time to live. */
      readonly now: number;
    }
  /** A message; from the person who started the turn, it steers it. */
  | {
      readonly type: "message.received";
      readonly text: string;
      readonly sender: SessionAuthContext | null;
    }
  /** An authorization's callback arrived; `failed` when it couldn't be read. */
  | {
      readonly type: "authorization.completed";
      /** What the response policy of each of its `policyChecks` did. */
      readonly verdicts?: Verdicts;
      readonly attemptId: string;
      readonly callback?: AuthorizationCallback;
      readonly connectionName: string;
      readonly outcome: "authorized" | "failed";
    }
  | { readonly type: "cancel.requested" }
  | { readonly type: "time"; readonly now: number }
  /**
   * The session's context was cleared, between turns: what its conversation
   * granted and settled goes with it. Requests children and runs relayed stay,
   * since they belong to whoever asked.
   */
  | { readonly type: "context.cleared" };

/**
 * What a child session, remote agent, or workflow run did through this
 * session, while the turn waits on it or between turns.
 */
export type FromRelay =
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
   * A child session or workflow run authorizes, or reports its responders'
   * approval candidates, through this session. The child completes its own
   * authorization on its callback; the session carries the exchange and records each
   * authorization until it completes.
   */
  | {
      readonly type: "relayed.authorization";
      readonly event: SubagentAuthorizationEvent;
      /** The child session or run that asked; nobody completes its authorization once it ends. */
      readonly runId: string;
    }
  /**
   * A delivery reached the session outside its turn's model steps: while the
   * turn waits on the calls that asked, or between turns. Only relayed
   * requests take from it; the runtime keeps the rest for the turn.
   */
  | {
      readonly type: "delivery.received";
      readonly responses: readonly InputResponse[];
      /** Its message as text, and whether a delegating caller sent it rather than a person. */
      readonly message?: { readonly text: string; readonly delegated: boolean };
    }
  /** A workflow run or child session ended; nobody can answer what it relayed. */
  | { readonly type: "run.ended"; readonly runId: string }
  /** A workflow run asks to withdraw its `ctx.ask()` question `requestId`. */
  | {
      readonly type: "relayed.withdrawn";
      readonly control: string;
      readonly requestId: string;
      readonly runId: string;
    };

/**
 * Turn bookkeeping the host commits itself, rather than something it saw.
 * Each is a candidate to become a query or part of how a turn settles.
 */
export type FromHost =
  /**
   * The turn stops to wait on a person: before its model call, or after a
   * step whose calls asked one. It resumes in the same turn once the person
   * answers, steers, or cancels.
   */
  | { readonly type: "turn.waiting" }
  /**
   * Once the held step settles, the turn's next step reads the input that
   * waited behind its calls, ahead of what arrived for it.
   */
  | { readonly type: "input.resumed" }
  /**
   * The turn a budget Stop ended settles as cancelled, from before the step
   * that read the Stop: its budget question is closed, and its resolution
   * was already published.
   */
  | { readonly type: "budget.stopped"; readonly requestId: string }
  /**
   * A cancel in the turn's step ended it; the session saved before that
   * step, which the turn settles from, closes what the cancel closed and
   * reported, without reporting it again.
   */
  | { readonly type: "cancel.replayed" };

/**
 * A response policy to run for one responder's answer, before the input that
 * proposes or readies its candidate is committed (`policyChecks`), with the
 * tools of the step that asked.
 */
export interface PolicyCheck {
  readonly at: RequestAt;
  readonly candidateId: string;
  readonly decision: CandidateDecision;
  readonly request: InputRequest;
  readonly requester: SessionAuthContext | null;
  readonly responder: SessionAuthContext;
  /**
   * The responder's authorization this input completes, which the policy reads as
   * it runs again. The policy binds its responder itself; the turn's person
   * stays who the turn runs as.
   */
  readonly authorization?: AuthorizationResult & { readonly name: string };
}

/** What each check's response policy did, by candidate id. */
export type Verdicts = Readonly<Record<string, PolicyRun>>;

/** What running a response policy did, before human input reads it as a verdict. */
export type PolicyRun =
  /** The tool no longer defines a response policy. */
  | { readonly kind: "missing" }
  | {
      readonly kind: "returned";
      readonly value: { readonly status: string; readonly reason?: string };
    }
  /** It threw or timed out; `challenges` when it threw for the responder to authorize. */
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

export type CandidateDecision = "approve" | "cancel";
