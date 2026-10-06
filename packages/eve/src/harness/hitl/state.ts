import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge, AuthorizationResult } from "#harness/authorization.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import type { ApprovalCandidateOutcome } from "#protocol/message.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

import type { Command } from "./command.js";
import type { CandidateDecision, PolicyCheck, RelayRoute, RequestAt } from "./input.js";

// ---------------------------------------------------------------------------
// State: one session key, read and written only here.
// ---------------------------------------------------------------------------

export const STATE_KEY = "eve.harness.humanInput";
/** Where sessions parked before the held step held runtime calls kept them. */
export const LEGACY_BATCH_KEY = "eve.runtime.pendingCoordinationBatch";

/**
 * Where releases before `HumanInput` parked a turn's requests and the input
 * that waited behind them: approvals and the budget question (the batch keys),
 * authorizations, requests relayed from children and runs, and deferred input.
 */
const PRE_HUMAN_INPUT_KEYS = [
  "eve.runtime.pendingInputBatches",
  "eve.runtime.pendingInputBatch",
  "eve.runtime.pendingAuthorization",
  "eve.runtime.proxyInputRequests",
  "eve.runtime.deferredStepInput",
  "eve.harness.pendingWorkflowInterrupt",
] as const;

/** Those releases left an empty list or map behind once nothing was open. */
function isParked(key: (typeof PRE_HUMAN_INPUT_KEYS)[number], value: unknown): boolean {
  if (value === undefined) return false;
  if (key === "eve.runtime.pendingInputBatches") return !Array.isArray(value) || value.length > 0;
  if (key === "eve.runtime.proxyInputRequests") {
    return typeof value !== "object" || value === null || Object.keys(value).length > 0;
  }
  return true;
}

/** See `HumanInput.unreadableKeys`. */
export function unreadableKeys(sessionState: SessionStateMap | undefined): readonly string[] {
  if (sessionState === undefined) return [];
  const keys = PRE_HUMAN_INPUT_KEYS.filter((key) => isParked(key, sessionState[key]));
  const own = sessionState[STATE_KEY];
  return own === undefined || isReadableState(own) ? keys : [STATE_KEY, ...keys];
}

/** What a rule leaves: the state, and the events it reports, in order. */
export interface Reduced<S = HumanInputState> {
  readonly events: readonly Command[];
  readonly state: S;
}

/** Exported only for the rules files beside this one. */
export interface HumanInputState {
  /** Every open request, by `requestId`. */
  readonly requests: Readonly<Record<string, OpenRequest>>;
  /** Turn input that waited behind a step's calls, for the turn's next step to read. */
  readonly queued?: StepInput;
  /** Approval keys a `once()` approval granted for the rest of the session. */
  readonly grants: readonly string[];
  /** The model step whose calls wait, held out of history. */
  readonly held?: HeldStep;
  /** Every response-policy candidate and settlement of the session. */
  readonly audit?: ApprovalAudit;
  /**
   * Sign-ins that completed for the turn's own calls, kept until the turn's
   * model step runs and its tools can read them (`model.starting`). Another
   * request can keep the turn waiting after a sign-in completes.
   */
  readonly authorized?: readonly AuthorizedResult[];
  /** Authorizations children and runs started through this session, by attempt id, until they complete. */
  readonly relayedAuthorizations?: Readonly<Record<string, RelayedAuthorization>>;
}

/** A completed sign-in, and who the turn runs as once its tools read it. */
export interface AuthorizedResult {
  readonly result: AuthorizationResult & { readonly name: string };
  readonly requester: SessionAuthContext | null;
}

type OpenRequest =
  | OpenApproval
  | OpenAuthorization
  | { readonly kind: "session-limit"; readonly at: RequestAt; readonly request: InputRequest }
  | OpenRelayed;

const EMPTY: HumanInputState = { grants: [], requests: {} };

/** Where sessions before `HumanInput` kept the tools approved for the session. */
export const LEGACY_GRANTS_KEY = "eve.runtime.hitl.approvedTools";

/**
 * The state stored under the session key, as stored. `readState`
 * (`state-legacy.ts`) upgrades what earlier releases stored.
 */
export function parseState(value: unknown): HumanInputState {
  return isReadableState(value) ? value : EMPTY;
}

function isReadableState(value: unknown): value is HumanInputState {
  if (typeof value !== "object" || value === null) return false;
  const requests: unknown = Reflect.get(value, "requests");
  const grants: unknown = Reflect.get(value, "grants");
  return typeof requests === "object" && requests !== null && Array.isArray(grants);
}

/** Stores `state` in the session's state, removing the key when nothing is open. */
export function store(
  sessionState: SessionStateMap | undefined,
  state: HumanInputState,
): SessionStateMap | undefined {
  const next: Record<string, unknown> = { ...sessionState };
  // `readState` moved a legacy batch and grants into `state`.
  delete next[LEGACY_BATCH_KEY];
  delete next[LEGACY_GRANTS_KEY];
  // This build can't honor what earlier releases parked there, and the turn
  // that commits here has moved on without it. Left behind, it would keep the
  // session from ever looking idle to a handoff.
  for (const key of PRE_HUMAN_INPUT_KEYS) delete next[key];
  if (isEmpty(state)) delete next[STATE_KEY];
  else next[STATE_KEY] = state;
  return Object.keys(next).length > 0 ? next : undefined;
}

function isEmpty(state: HumanInputState): boolean {
  return (
    Object.keys(state.requests).length === 0 &&
    state.queued === undefined &&
    state.held === undefined &&
    state.grants.length === 0 &&
    state.audit === undefined &&
    (state.authorized?.length ?? 0) === 0 &&
    Object.keys(state.relayedAuthorizations ?? {}).length === 0
  );
}

// ---------------------------------------------------------------------------
// What each kind of request keeps open
// ---------------------------------------------------------------------------

/** An open approval, as the session stores it. */
export interface OpenApproval {
  readonly kind: "tool-approval";
  readonly at: RequestAt;
  readonly request: InputRequest;
  readonly requester: SessionAuthContext | null;
  /** What a `once()` approval grants: the tool's approval key, else its name. */
  readonly approvalKey: string;
  /** An answer that arrived before the rest of the step's approvals were answered. */
  readonly answer?: InputResponse;
  /** Its tool's `approval.response` policy decides who may answer (see candidates). */
  readonly responsePolicy?: true;
}

/** An open authorization, as the session stores it. */
export interface OpenAuthorization {
  readonly kind: "authorization";
  readonly at: RequestAt;
  readonly challenge: AuthorizationChallenge;
}

/** A model step held out of history until every call it made has a result. */
export interface HeldStep {
  readonly at: RequestAt;
  /** The step's response and the results it has so far. */
  readonly messages: readonly ModelMessage[];
  /**
   * Set once some of its calls run as runtime work: the workflow runs they
   * start. Its task tool calls run there too; the session answers them.
   */
  readonly runtime?: {
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
    readonly approvers?: Readonly<Record<string, SessionAuthContext>>;
  };
  /**
   * Calls a person approved that haven't run yet. The turn runs them
   * (`approvedCalls`) before it reads anything else.
   */
  readonly approved?: readonly InputRequest[];
  /** Turn input that arrived while its calls waited, read after their results. */
  readonly following?: StepInput;
}

/** A relayed request, as the session stores it until it is answered or withdrawn. */
export interface OpenRelayed {
  readonly kind: "relayed";
  /** The coordinates of the child batch's `input.requested`, which its `input.resolved` repeats. */
  readonly at: RequestAt;
  readonly request: InputRequest;
  readonly route: RelayRoute;
}

/** An authorization a child or run started through this session, recorded until it completes. */
export interface RelayedAuthorization {
  readonly at: RequestAt;
  readonly name: string;
  readonly runId: string;
}

/** A candidate waiting on its policy, or on its responder's authorization. */
export interface ActiveCandidate {
  readonly candidateId: string;
  readonly createdAt: number;
  readonly decision: CandidateDecision;
  readonly expiresAt: number;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly status: "pending" | "authorization-required";
  /** The authorizations its policy waits on, while `authorization-required`. */
  readonly authorizations?: readonly AuthorizationChallenge[];
  /** Callbacks of the ones that completed, kept until its policy runs again. */
  readonly authorized?: readonly NonNullable<PolicyCheck["authorizations"]>[number][];
}

/** Who answered, narrowed to identity for the audit's finished records. */
export interface ResponderIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
}

export interface FinishedCandidate {
  readonly candidateId: string;
  readonly createdAt: number;
  readonly decision: CandidateDecision;
  readonly expiresAt: number;
  readonly reason?: string;
  readonly requestId: string;
  readonly responder: ResponderIdentity;
  readonly status: "allowed" | Exclude<ApprovalCandidateOutcome, "pending">;
}

/** An approval a signed-in person settled: through a candidate, or directly. */
export interface Settlement {
  readonly actor: ResponderIdentity;
  /** The full auth of the approver, absent for cancellations. */
  readonly approver?: SessionAuthContext;
  readonly candidateId?: string;
  readonly outcome: "allowed" | "cancelled";
  readonly requestId: string;
}

/** The durable candidate audit, kept in human input's state. */
export interface ApprovalAudit {
  readonly activeCandidates: Readonly<Record<string, ActiveCandidate>>;
  readonly candidateHistory: readonly FinishedCandidate[];
  readonly nextCandidateSequence: number;
  readonly settlements: Readonly<Record<string, Settlement>>;
}

export const EMPTY_AUDIT: ApprovalAudit = {
  activeCandidates: {},
  candidateHistory: [],
  nextCandidateSequence: 0,
  settlements: {},
};

export function isOpenRelayed(value: { readonly kind: string } | undefined): value is OpenRelayed {
  return value?.kind === "relayed";
}
