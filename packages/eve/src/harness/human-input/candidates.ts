/**
 * The response-policy rules. An answer to an approval whose tool defines
 * `approval.response` doesn't answer it: it becomes a candidate, bound to the
 * person who sent it, and the runtime runs the policy (`responder.check`).
 * The first candidate the policy allows settles the approval with its
 * decision, and every competing candidate goes stale. A rejected, failed, or
 * expired candidate leaves the approval open for another answer. A policy
 * that needs the responder to sign in holds the candidate on that sign-in,
 * which belongs to it rather than opening a request of its own, and runs
 * again once it completes.
 *
 * Every candidate and settlement is kept in the session's audit, so a retry
 * gets a fresh candidate and a settled approval can't be settled again.
 */
import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { OpenApproval } from "#harness/human-input/approvals.js";
import type {
  HumanInputEvent,
  HumanInputState,
  Intake,
  PolicyRun,
  RequestAt,
  Reduced,
} from "#harness/human-input/index.js";
import { completed, signInRequested } from "#harness/human-input/sign-ins.js";
import {
  createApprovalCandidateEvent,
  createApprovalSettledEvent,
  createMessageCompletedEvent,
  type ApprovalCandidateOutcome,
} from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";

const CANDIDATE_TTL_MS = 10 * 60_000;
const UNAUTHENTICATED_FEEDBACK = "Authentication is required to respond to this approval.";
const FAILED_REASON = "We couldn’t verify your response. Please try again.";
const UNAVAILABLE_REASON = "Approval authorization is temporarily unavailable. Please try again.";
const EXPIRED_REASON = "The approval response expired. Please submit a new response.";
const SETTLED_REASON = "Another response settled this approval.";

export type CandidateDecision = "approve" | "cancel";

/** A candidate waiting on its policy, or on its responder's sign-in. */
interface ActiveCandidate {
  readonly candidateId: string;
  readonly createdAt: number;
  readonly decision: CandidateDecision;
  readonly expiresAt: number;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly status: "pending" | "authorization-required";
  /** The sign-ins its policy waits on, while `authorization-required`. */
  readonly signIns?: readonly AuthorizationChallenge[];
}

/** Who answered, narrowed to identity for the audit's finished records. */
interface ResponderIdentity {
  readonly authenticator: string;
  readonly issuer?: string;
  readonly principalId: string;
  readonly principalType: string;
}

interface FinishedCandidate {
  readonly candidateId: string;
  readonly createdAt: number;
  readonly decision: CandidateDecision;
  readonly expiresAt: number;
  readonly reason?: string;
  readonly requestId: string;
  readonly responder: ResponderIdentity;
  readonly status: "allowed" | Exclude<ApprovalCandidateOutcome, "pending">;
}

interface Settlement {
  readonly actor: ResponderIdentity;
  readonly candidateId: string;
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

/**
 * Answers to policy-gated approvals become candidates, each checked by its
 * policy. An answer without a decision, a repeat of an active candidate, or an
 * answer to an approval already settled changes nothing; an answer nobody
 * signed is refused, since the policy decides who may answer.
 */
export function proposeCandidates(
  state: HumanInputState,
  input: {
    readonly now: number;
    readonly responder: SessionAuthContext | null;
    readonly responses: readonly InputResponse[];
  },
): Reduced {
  let next = state;
  const events: HumanInputEvent[] = [];
  for (const response of input.responses) {
    const approval = next.requests[response.requestId];
    if (approval?.kind !== "tool-approval" || approval.answer !== undefined) continue;
    const decision = decisionOf(response.optionId);
    if (decision === undefined) continue;
    if (input.responder === null) {
      events.push({
        event: createMessageCompletedEvent({ message: UNAUTHENTICATED_FEEDBACK, ...approval.at }),
        type: "publish",
      });
      continue;
    }
    const responder = input.responder;
    const audit = auditOf(next);
    const repeated = Object.values(audit.activeCandidates).some(
      (candidate) =>
        candidate.requestId === response.requestId &&
        candidate.decision === decision &&
        sameResponder(candidate.responder, responder),
    );
    if (repeated) continue;
    const candidate: ActiveCandidate = {
      candidateId: candidateIdFor(audit, response.requestId, responder, decision),
      createdAt: input.now,
      decision,
      expiresAt: input.now + CANDIDATE_TTL_MS,
      requestId: response.requestId,
      responder,
      status: "pending",
    };
    next = withAudit(next, {
      ...audit,
      activeCandidates: { ...audit.activeCandidates, [candidate.candidateId]: candidate },
      nextCandidateSequence: audit.nextCandidateSequence + 1,
    });
    events.push(candidateEvent(approval.at, candidate, "pending"), check(approval, candidate));
  }
  return { events, state: next };
}

/**
 * The runtime ran a candidate's policy. Allowed settles the approval and
 * returns the answer it settled with, for the approval rules to apply. A
 * verdict for a candidate no longer active (expired, stale) changes nothing.
 */
export function checkedCandidate(
  state: HumanInputState,
  input: Extract<Intake, { readonly type: "responder.checked" }>,
): Reduced & { readonly settled?: InputResponse } {
  const candidate = auditOf(state).activeCandidates[input.candidateId];
  const approval = candidate === undefined ? undefined : state.requests[candidate.requestId];
  if (candidate === undefined || approval?.kind !== "tool-approval") return { events: [], state };
  const verdict = verdictOf(input.ran);
  switch (verdict.verdict) {
    case "allowed":
      return settle(state, approval, candidate);
    case "rejected":
      return finish(state, [candidate], "rejected", verdict.reason);
    case "failed":
      return finish(state, [candidate], "failed", verdict.reason ?? FAILED_REASON);
    case "authorization-required": {
      // Each sign-in is the responder's and settles only this candidate.
      const signIns = verdict.challenges.map((challenge) => ({
        ...challenge,
        candidateId: candidate.candidateId,
        requester: challenge.requester ?? candidate.responder,
      }));
      const waiting: ActiveCandidate = { ...candidate, signIns, status: "authorization-required" };
      return {
        events: signIns.map((challenge) => signInRequested(challenge, approval.at)),
        state: withCandidate(state, waiting),
      };
    }
  }
}

type Verdict =
  | { readonly verdict: "allowed" }
  | { readonly verdict: "rejected"; readonly reason?: string }
  | { readonly verdict: "failed"; readonly reason?: string }
  | {
      readonly verdict: "authorization-required";
      readonly challenges: readonly AuthorizationChallenge[];
    };

/**
 * A policy allows or rejects by what it returns. Anything else fails the
 * candidate, except a throw that asks the responder to sign in first.
 */
function verdictOf(ran: PolicyRun): Verdict {
  switch (ran.kind) {
    case "missing":
      return { reason: UNAVAILABLE_REASON, verdict: "failed" };
    case "returned":
      if (ran.value.status === "allowed") return { verdict: "allowed" };
      if (ran.value.status === "rejected") return { reason: ran.value.reason, verdict: "rejected" };
      return { verdict: "failed" };
    case "threw":
      return ran.challenges === undefined
        ? { verdict: "failed" }
        : { challenges: ran.challenges, verdict: "authorization-required" };
  }
}

/**
 * A callback arrived for a responder's sign-in. Once authorized, its callback
 * goes to the policy, which runs again as soon as the candidate waits on no
 * other sign-in; a failed sign-in fails the candidate. A callback for no
 * candidate's sign-in returns `undefined`.
 */
export function completeCandidateSignIn(
  state: HumanInputState,
  input: Extract<Intake, { readonly type: "authorization.completed" }>,
): Reduced | undefined {
  const candidate = Object.values(auditOf(state).activeCandidates).find((active) =>
    active.signIns?.some((challenge) => opens(challenge, input)),
  );
  const approval = candidate === undefined ? undefined : state.requests[candidate.requestId];
  if (candidate === undefined || approval?.kind !== "tool-approval") return undefined;
  const challenge = candidate.signIns!.find((signIn) => opens(signIn, input))!;
  const events: HumanInputEvent[] = [completed(challenge, approval.at, input.outcome)];
  if (input.outcome === "failed") {
    const failed = finish(
      withCandidate(state, without(candidate, challenge)),
      [candidate],
      "failed",
      FAILED_REASON,
    );
    return { events: [...events, ...failed.events], state: failed.state };
  }
  if (input.callback !== undefined) {
    events.push({
      // The policy binds its responder itself; the turn's person stays who it runs as.
      requester: null,
      result: {
        attemptId: input.attemptId,
        callback: input.callback,
        hookUrl: challenge.hookUrl,
        instanceId: challenge.instanceId,
        name: challenge.name,
        principal: challenge.principal,
        resume: challenge.resume,
      },
      type: "sign-in.completed",
    });
  }
  const rest = without(candidate, challenge);
  if ((rest.signIns?.length ?? 0) > 0) return { events, state: withCandidate(state, rest) };
  const { signIns: _done, ...ready } = rest;
  const pending: ActiveCandidate = { ...ready, status: "pending" };
  return { events: [...events, check(approval, pending)], state: withCandidate(state, pending) };
}

/** The attempt ids of the sign-ins responders' candidates wait on. */
export function candidateSignInAttempts(state: HumanInputState): readonly string[] {
  return Object.values(auditOf(state).activeCandidates).flatMap((candidate) =>
    (candidate.signIns ?? []).flatMap((challenge) =>
      challenge.attemptId === undefined ? [] : [challenge.attemptId],
    ),
  );
}

/**
 * A session stored while a responder's sign-in was an open request of its own:
 * each such sign-in moves to its candidate, and one whose candidate is gone closes.
 */
export function adoptCandidateSignIns(state: HumanInputState): HumanInputState {
  const legacy = Object.entries(state.requests).filter(
    ([, open]) => open.kind === "authorization" && open.challenge.candidateId !== undefined,
  );
  if (legacy.length === 0) return state;
  const requests = { ...state.requests };
  let next: HumanInputState = state;
  for (const [key, open] of legacy) {
    delete requests[key];
    if (open.kind !== "authorization") continue;
    const candidate = auditOf(next).activeCandidates[open.challenge.candidateId!];
    if (candidate === undefined) continue;
    next = withCandidate(next, {
      ...candidate,
      signIns: [...(candidate.signIns ?? []), open.challenge],
      status: "authorization-required",
    });
  }
  return { ...next, requests };
}

function opens(
  challenge: AuthorizationChallenge,
  input: { readonly attemptId: string; readonly connectionName: string },
): boolean {
  return (
    (challenge.attemptId ?? challenge.candidateId ?? challenge.name) === input.attemptId &&
    challenge.name === input.connectionName
  );
}

function without(candidate: ActiveCandidate, challenge: AuthorizationChallenge): ActiveCandidate {
  return { ...candidate, signIns: candidate.signIns?.filter((signIn) => signIn !== challenge) };
}

function withCandidate(state: HumanInputState, candidate: ActiveCandidate): HumanInputState {
  const audit = auditOf(state);
  return withAudit(state, {
    ...audit,
    activeCandidates: { ...audit.activeCandidates, [candidate.candidateId]: candidate },
  });
}

/** Candidates past their deadline time out, and their sign-ins fail. */
export function expireCandidates(state: HumanInputState, now: number): Reduced {
  const expired = Object.values(auditOf(state).activeCandidates).filter(
    (candidate) => candidate.expiresAt <= now,
  );
  return finish(state, expired, "timed-out", undefined, {
    outcome: "failed",
    reason: EXPIRED_REASON,
  });
}

/**
 * The turn moved past its approvals, steered or cancelled: every active
 * candidate goes stale. Their sign-ins close with the turn's other sign-ins.
 */
export function staleCandidates(state: HumanInputState, reason: string): Reduced {
  return finish(state, Object.values(auditOf(state).activeCandidates), "stale", reason);
}

/** Settles the approval with the allowed candidate's decision; its competitors go stale. */
function settle(
  state: HumanInputState,
  approval: OpenApproval,
  winner: ActiveCandidate,
): Reduced & { readonly settled: InputResponse } {
  const competitors = Object.values(auditOf(state).activeCandidates).filter(
    (candidate) =>
      candidate.requestId === winner.requestId && candidate.candidateId !== winner.candidateId,
  );
  const stale = finish(state, competitors, "stale", SETTLED_REASON, {
    outcome: "declined",
    reason: SETTLED_REASON,
  });
  const allowed = finish(stale.state, [winner], "allowed");
  const audit = auditOf(allowed.state);
  const settlement: Settlement = {
    actor: identityOf(winner.responder),
    candidateId: winner.candidateId,
    outcome: winner.decision === "approve" ? "allowed" : "cancelled",
    requestId: winner.requestId,
  };
  return {
    events: [
      ...stale.events,
      {
        event: createApprovalSettledEvent({
          outcome: winner.decision === "approve" ? "approved" : "cancelled",
          requestId: winner.requestId,
          responderPrincipalId: winner.responder.principalId,
          ...approval.at,
        }),
        type: "publish",
      },
    ],
    settled: { optionId: winner.decision, requestId: winner.requestId },
    state: withAudit(allowed.state, {
      ...audit,
      settlements: { ...audit.settlements, [winner.requestId]: settlement },
    }),
  };
}

/**
 * Moves candidates to the audit's history with `status`, reporting each but
 * an allowed one (its settlement reports it). The sign-ins they still wait on
 * close with them: `signIns` says how, declined with `reason` by default.
 */
function finish(
  state: HumanInputState,
  candidates: readonly ActiveCandidate[],
  status: FinishedCandidate["status"],
  reason?: string,
  signIns: { readonly outcome: "declined" | "failed"; readonly reason?: string } = {
    outcome: "declined",
    reason,
  },
): Reduced {
  if (candidates.length === 0) return { events: [], state };
  const audit = auditOf(state);
  const activeCandidates = { ...audit.activeCandidates };
  const events: HumanInputEvent[] = [];
  const closed: HumanInputEvent[] = [];
  const finished: FinishedCandidate[] = [];
  for (const { candidateId } of candidates) {
    // The candidate as stored: what it still waits on.
    const candidate =
      activeCandidates[candidateId] ?? candidates.find((c) => c.candidateId === candidateId)!;
    delete activeCandidates[candidateId];
    const { responder, signIns: waiting, status: _status, ...rest } = candidate;
    finished.push({
      ...rest,
      ...(reason !== undefined && { reason }),
      responder: identityOf(responder),
      status,
    });
    const approval = state.requests[candidate.requestId];
    if (approval?.kind !== "tool-approval") continue;
    if (status !== "allowed") events.push(candidateEvent(approval.at, candidate, status, reason));
    for (const challenge of waiting ?? []) {
      closed.push(completed(challenge, approval.at, signIns.outcome, signIns.reason));
    }
  }
  return {
    events: [...events, ...closed],
    state: withAudit(state, {
      ...audit,
      activeCandidates,
      candidateHistory: [...audit.candidateHistory, ...finished],
    }),
  };
}

function check(approval: OpenApproval, candidate: ActiveCandidate): HumanInputEvent {
  return {
    at: approval.at,
    candidateId: candidate.candidateId,
    decision: candidate.decision,
    request: approval.request,
    requester: approval.requester,
    responder: candidate.responder,
    type: "responder.check",
  };
}

function candidateEvent(
  at: RequestAt,
  candidate: ActiveCandidate,
  outcome: ApprovalCandidateOutcome,
  reason?: string,
): HumanInputEvent {
  return {
    event: createApprovalCandidateEvent({
      candidateId: candidate.candidateId,
      outcome,
      ...(reason !== undefined && { reason }),
      requestId: candidate.requestId,
      responderPrincipalId: candidate.responder.principalId,
      ...at,
    }),
    type: "publish",
  };
}

function decisionOf(optionId: string | undefined): CandidateDecision | undefined {
  if (optionId === "approve") return "approve";
  // ACP answers with "deny"; eve's own approval prompts offer "cancel".
  if (optionId === "cancel" || optionId === "deny") return "cancel";
  return undefined;
}

/**
 * One id per request, responder, and decision, so both an Approve and a
 * Cancel can be pending. A retry after a finished candidate gets a fresh id,
 * so its events never read as the earlier candidate's.
 */
function candidateIdFor(
  audit: ApprovalAudit,
  requestId: string,
  responder: SessionAuthContext,
  decision: CandidateDecision,
): string {
  const principal = [
    responder.authenticator,
    responder.issuer ?? "",
    responder.principalType,
    responder.principalId,
  ].join(":");
  const base = [requestId, principal, ...(decision === "approve" ? [] : [decision])]
    .map(encodeIdPart)
    .join(".");
  const used =
    audit.activeCandidates[base] !== undefined ||
    audit.candidateHistory.some((candidate) => candidate.candidateId === base);
  return used ? `${base}.${audit.nextCandidateSequence.toString(36)}` : base;
}

function encodeIdPart(value: string): string {
  return Array.from(value, (character) => character.codePointAt(0)!.toString(36)).join("-");
}

function sameResponder(left: SessionAuthContext, right: SessionAuthContext): boolean {
  return (
    left.authenticator === right.authenticator &&
    left.issuer === right.issuer &&
    left.principalId === right.principalId &&
    left.principalType === right.principalType
  );
}

function identityOf(responder: SessionAuthContext): ResponderIdentity {
  return {
    authenticator: responder.authenticator,
    ...(responder.issuer !== undefined && { issuer: responder.issuer }),
    principalId: responder.principalId,
    principalType: responder.principalType,
  };
}

const EMPTY_AUDIT: ApprovalAudit = {
  activeCandidates: {},
  candidateHistory: [],
  nextCandidateSequence: 0,
  settlements: {},
};

function auditOf(state: HumanInputState): ApprovalAudit {
  return state.audit ?? EMPTY_AUDIT;
}

function withAudit(state: HumanInputState, audit: ApprovalAudit): HumanInputState {
  return { ...state, audit };
}
