import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import {
  readTurnInputRequests,
  replaceTurnInputRequest,
  type TurnInputRequest,
} from "#harness/open-input-requests.js";
import type { SessionStateMap } from "#harness/types.js";
import {
  createApprovalCandidateEvent,
  createApprovalSettledEvent,
  type ApprovalCandidateOutcome,
  type ApprovalCandidateStreamEvent,
  type ApprovalSettledStreamEvent,
} from "#protocol/message.js";

/** What a responder submitted: a candidate settles its request this way once allowed. */
export type ApprovalCandidateDecision = "approve" | "cancel";

/** One responder's answer to a tool approval, held while its response policy checks it. */
export interface ActiveApprovalCandidate {
  readonly candidateId: string;
  readonly decision: ApprovalCandidateDecision;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly status: "pending" | "authorization-required";
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly authorizationChallenges?: readonly AuthorizationChallenge[];
}

/** The stream events a candidate transition reports; its caller emits them at once. */
export type ApprovalCandidateEvent = ApprovalCandidateStreamEvent | ApprovalSettledStreamEvent;

/** Where a transition's events sit in the stream. */
export type ApprovalEventCoordinates = Pick<
  HarnessEmissionState,
  "sequence" | "stepIndex" | "turnId"
>;

interface ApprovalCandidateTransition {
  readonly changed: boolean;
  readonly events: readonly ApprovalCandidateEvent[];
  readonly state: SessionStateMap | undefined;
}

/** Every candidate still being checked, across the open approvals. */
export function readApprovalCandidates(
  state: SessionStateMap | undefined,
): readonly ActiveApprovalCandidate[] {
  return [...readTurnInputRequests(state).values()].flatMap((entry) =>
    Object.values(entry.candidates ?? {}),
  );
}

/** Returns one active candidate by id. */
export function getActiveApprovalCandidate(
  state: SessionStateMap | undefined,
  candidateId: string,
): ActiveApprovalCandidate | undefined {
  return readApprovalCandidates(state).find((candidate) => candidate.candidateId === candidateId);
}

/** The open approvals already settled, with the decision that settled each. */
export function readSettledApprovals(state: SessionStateMap | undefined): readonly {
  readonly decision: ApprovalCandidateDecision;
  readonly requestId: string;
}[] {
  return [...readTurnInputRequests(state).values()].flatMap((entry) =>
    entry.settled === undefined
      ? []
      : [{ decision: entry.settled, requestId: entry.request.requestId }],
  );
}

/** Creates or deduplicates one responder's candidate decision for an open approval. */
export function createApprovalCandidate(input: {
  readonly at: ApprovalEventCoordinates;
  readonly candidateIdPrefix: string;
  readonly createdAt: number;
  readonly decision: ApprovalCandidateDecision;
  readonly expiresAt: number;
  readonly requestId: string;
  readonly responder: SessionAuthContext;
  readonly state: SessionStateMap | undefined;
}): ApprovalCandidateTransition {
  const expired = expireApprovalCandidates({
    at: input.at,
    now: input.createdAt,
    state: input.state,
  });
  const entry = readTurnInputRequests(expired.state).get(input.requestId);
  const candidates = entry?.candidates ?? {};
  if (
    entry === undefined ||
    entry.settled !== undefined ||
    Object.values(candidates).some(
      (candidate) =>
        candidate.decision === input.decision &&
        sameResponder(candidate.responder, input.responder),
    )
  ) {
    return { ...expired, changed: false };
  }

  // Only the approval's first candidate goes unnumbered, so a responder's
  // retry never reuses the id of a candidate that already finished.
  const sequence = entry.candidateSequence ?? 0;
  const candidateId =
    sequence === 0
      ? input.candidateIdPrefix
      : `${input.candidateIdPrefix}.${sequence.toString(36)}`;
  const candidate: ActiveApprovalCandidate = {
    candidateId,
    createdAt: input.createdAt,
    decision: input.decision,
    expiresAt: input.expiresAt,
    requestId: input.requestId,
    responder: input.responder,
    status: "pending",
  };
  return {
    changed: true,
    events: [...expired.events, candidateEvent(candidate, "pending", input.at)],
    state: replaceTurnInputRequest(expired.state, {
      ...entry,
      candidateSequence: sequence + 1,
      candidates: { ...candidates, [candidateId]: candidate },
    }),
  };
}

/** Marks a candidate as waiting on a private authorization challenge. */
export function markApprovalCandidateAuthorizationRequired(input: {
  readonly authorizationChallenges: readonly AuthorizationChallenge[];
  readonly candidateId: string;
  readonly expiresAt?: number;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const entry = entryWithCandidate(input.state, input.candidateId);
  const candidate = entry?.candidates?.[input.candidateId];
  if (entry === undefined || candidate === undefined) return input.state;
  return replaceTurnInputRequest(input.state, {
    ...entry,
    candidates: {
      ...entry.candidates,
      [input.candidateId]: {
        ...candidate,
        authorizationChallenges: input.authorizationChallenges,
        expiresAt: input.expiresAt ?? candidate.expiresAt,
        status: "authorization-required",
      },
    },
  });
}

/** Finishes one candidate without settling its approval. */
export function finishApprovalCandidate(input: {
  readonly at: ApprovalEventCoordinates;
  readonly candidateId: string;
  readonly reason?: string;
  readonly state: SessionStateMap | undefined;
  readonly status: Exclude<ApprovalCandidateOutcome, "pending">;
}): ApprovalCandidateTransition {
  const entry = entryWithCandidate(input.state, input.candidateId);
  const candidate = entry?.candidates?.[input.candidateId];
  if (entry === undefined || candidate === undefined) {
    return { changed: false, events: [], state: input.state };
  }
  const { [input.candidateId]: _finished, ...remaining } = entry.candidates ?? {};
  return {
    changed: true,
    events: [candidateEvent(candidate, input.status, input.at, input.reason)],
    state: replaceTurnInputRequest(input.state, withCandidates(entry, remaining)),
  };
}

/** Expires active candidates whose deadline has passed. */
export function expireApprovalCandidates(input: {
  readonly at: ApprovalEventCoordinates;
  readonly now: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalCandidateTransition {
  let changed = false;
  const events: ApprovalCandidateEvent[] = [];
  let state = input.state;
  for (const candidate of readApprovalCandidates(input.state)) {
    if (candidate.expiresAt > input.now) continue;
    const finished = finishApprovalCandidate({
      at: input.at,
      candidateId: candidate.candidateId,
      state,
      status: "timed-out",
    });
    changed = true;
    events.push(...finished.events);
    state = finished.state;
  }
  return { changed, events, state };
}

/**
 * Settles an approval with an allowed candidate's decision; every competing
 * candidate becomes stale. A candidate already gone changes nothing.
 */
export function settleAllowedCandidate(input: {
  readonly at: ApprovalEventCoordinates;
  readonly candidateId: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalCandidateTransition {
  const expired = expireApprovalCandidates({
    at: input.at,
    now: input.settledAt,
    state: input.state,
  });
  const candidate = getActiveApprovalCandidate(expired.state, input.candidateId);
  if (candidate === undefined) return { ...expired, changed: false };
  return settleRequest(expired, {
    actor: candidate.responder,
    at: input.at,
    candidateId: candidate.candidateId,
    decision: candidate.decision,
    requestId: candidate.requestId,
  });
}

/** Settles an approval with a direct authenticated response. */
export function settleDirectApprovalResponse(input: {
  readonly actor: SessionAuthContext;
  readonly at: ApprovalEventCoordinates;
  readonly decision: ApprovalCandidateDecision;
  readonly requestId: string;
  readonly settledAt: number;
  readonly state: SessionStateMap | undefined;
}): ApprovalCandidateTransition {
  const expired = expireApprovalCandidates({
    at: input.at,
    now: input.settledAt,
    state: input.state,
  });
  return settleRequest(expired, input);
}

function settleRequest(
  expired: ApprovalCandidateTransition,
  input: {
    readonly actor: SessionAuthContext;
    readonly at: ApprovalEventCoordinates;
    readonly candidateId?: string;
    readonly decision: ApprovalCandidateDecision;
    readonly requestId: string;
  },
): ApprovalCandidateTransition {
  const entry = readTurnInputRequests(expired.state).get(input.requestId);
  if (entry === undefined || entry.settled !== undefined) return { ...expired, changed: false };
  const stale = Object.values(entry.candidates ?? {}).filter(
    (candidate) => candidate.candidateId !== input.candidateId,
  );
  return {
    changed: true,
    events: [
      ...expired.events,
      ...stale.map((candidate) => candidateEvent(candidate, "stale", input.at)),
      createApprovalSettledEvent({
        outcome: input.decision === "approve" ? "approved" : "cancelled",
        requestId: input.requestId,
        responderPrincipalId: input.actor.principalId,
        sequence: input.at.sequence,
        stepIndex: input.at.stepIndex,
        turnId: input.at.turnId,
      }),
    ],
    state: replaceTurnInputRequest(expired.state, {
      ...withCandidates(entry, {}),
      settled: input.decision,
    }),
  };
}

function candidateEvent(
  candidate: ActiveApprovalCandidate,
  outcome: ApprovalCandidateOutcome,
  at: ApprovalEventCoordinates,
  reason?: string,
): ApprovalCandidateStreamEvent {
  const data = {
    candidateId: candidate.candidateId,
    outcome,
    requestId: candidate.requestId,
    responderPrincipalId: candidate.responder.principalId,
    sequence: at.sequence,
    stepIndex: at.stepIndex,
    turnId: at.turnId,
  };
  return createApprovalCandidateEvent(outcome === "pending" ? data : { ...data, reason });
}

function entryWithCandidate(
  state: SessionStateMap | undefined,
  candidateId: string,
): TurnInputRequest | undefined {
  return [...readTurnInputRequests(state).values()].find(
    (entry) => entry.candidates?.[candidateId] !== undefined,
  );
}

function withCandidates(
  entry: TurnInputRequest,
  candidates: Readonly<Record<string, ActiveApprovalCandidate>>,
): TurnInputRequest {
  const { candidates: _previous, ...rest } = entry;
  return Object.keys(candidates).length === 0 ? rest : { ...rest, candidates };
}

function sameResponder(a: SessionAuthContext, b: SessionAuthContext): boolean {
  return (
    a.authenticator === b.authenticator &&
    a.issuer === b.issuer &&
    a.principalId === b.principalId &&
    a.principalType === b.principalType
  );
}
