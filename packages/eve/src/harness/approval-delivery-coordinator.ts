import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { contextStorage } from "#context/container.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import {
  buildApprovalResponseAuth,
  handleApprovalResponsePolicyError,
} from "#execution/tool-auth.js";
import {
  createApprovalCandidate,
  expireApprovalCandidates,
  finishApprovalCandidate,
  getActiveApprovalCandidate,
  markApprovalCandidateAuthorizationRequired,
  readApprovalCandidates,
  readSettledApprovals,
  settleAllowedCandidate,
  settleDirectApprovalResponse,
  type ActiveApprovalCandidate,
  type ApprovalCandidateDecision,
  type ApprovalCandidateEvent,
  type ApprovalEventCoordinates,
} from "#harness/approval-candidates.js";
import { authorizationEventFields } from "#harness/authorization-event-fields.js";
import {
  clearPendingAuthorization,
  getAuthorizationResult,
  getPendingAuthorization,
  isAuthorizationSignal,
  type AuthorizationChallenge,
} from "#harness/authorization.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import { openApprovalRequester, readOpenApprovals } from "#harness/open-approvals.js";
import type { HarnessSession, HarnessToolMap, StepInput } from "#harness/types.js";
import {
  createAuthorizationCompletedEvent,
  type AuthorizationCompletedStreamEvent,
} from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";

const UNAUTHENTICATED_APPROVAL_FEEDBACK = "Authentication is required to respond to this approval.";
const APPROVAL_AUTHORIZER_TIMEOUT_MS = 10_000;
const APPROVAL_CANDIDATE_TTL_MS = 10 * 60_000;

type ApprovalDeliveryEvent = ApprovalCandidateEvent | AuthorizationCompletedStreamEvent;

interface ApprovalDeliveryResult {
  readonly challenges: readonly AuthorizationChallenge[];
  /** What this pass changed, for the caller to emit now. */
  readonly events: readonly ApprovalDeliveryEvent[];
  readonly feedback: readonly string[];
  readonly kind:
    | "continue"
    | "continue-coordination"
    | "authorization-required"
    | "responses-completed";
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
}

/**
 * Advances approval state by one durable phase.
 *
 * | State | Input | Transition |
 * | --- | --- | --- |
 * | pending request | Approve or Cancel | create responder-bound candidate |
 * | pending candidate | coordinator pass | run current authorizer |
 * | pending candidate | allowed | settle with its decision; competitors go stale |
 * | pending candidate | rejected/error/expiry | finish the candidate |
 * | pending candidate | authorization required | persist private challenge |
 * | authorization required | matching callback | re-run current authorizer |
 * | settled request | any later response | no state change |
 *
 * Delivery ingestion returns before authorizer work so candidate creation
 * commits before long-running policy execution.
 */
export async function coordinateApprovalDelivery(input: {
  readonly emissionState: ApprovalEventCoordinates;
  readonly now?: number;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
  readonly tools: HarnessToolMap;
  readonly prepareTools?: (request: InputRequest) => Promise<HarnessToolMap>;
}): Promise<ApprovalDeliveryResult> {
  const events: ApprovalCandidateEvent[] = [];
  const result = await coordinate(input, events);
  const timedOut = new Set(
    events.flatMap((event) =>
      event.type === "approval.candidate" && event.data.outcome === "timed-out"
        ? [event.data.candidateId]
        : [],
    ),
  );
  const failedSignIns = (getPendingAuthorization(input.session.state)?.challenges ?? [])
    .filter(
      (challenge) => challenge.candidateId !== undefined && timedOut.has(challenge.candidateId),
    )
    .map((challenge) =>
      createAuthorizationCompletedEvent({
        ...authorizationEventFields(challenge),
        outcome: "failed",
        reason: "The approval response expired. Please submit a new response.",
        sequence: input.emissionState.sequence,
        stepIndex: input.emissionState.stepIndex,
        turnId: input.emissionState.turnId,
      }),
    );
  // By kind, so a settlement follows the candidates it ends: failed sign-ins,
  // new candidates, finished candidates, then settlements.
  const rank = (event: ApprovalCandidateEvent) =>
    event.type === "approval.settled" ? 2 : event.data.outcome === "pending" ? 0 : 1;
  return {
    ...result,
    events: [...failedSignIns, ...[...events].sort((a, b) => rank(a) - rank(b))],
  };
}

async function coordinate(
  input: Parameters<typeof coordinateApprovalDelivery>[0],
  events: ApprovalCandidateEvent[],
): Promise<Omit<ApprovalDeliveryResult, "events">> {
  const at = input.emissionState;
  const now = input.now ?? Date.now();
  const expiredChallengeIds = readApprovalCandidates(input.session.state)
    .filter((candidate) => candidate.expiresAt <= now)
    .flatMap(
      (candidate) =>
        candidate.authorizationChallenges?.map(
          (challenge) => challenge.attemptId ?? challenge.candidateId ?? challenge.name,
        ) ?? [],
    );
  const expired = expireApprovalCandidates({ at, now, state: input.session.state });
  events.push(...expired.events);
  let session: HarnessSession = {
    ...input.session,
    state: clearPendingAuthorization(expired.state, expiredChallengeIds),
  };
  const stepInput = input.stepInput;
  const approvals = readOpenApprovals(session.state);
  if (approvals === undefined) return deliveryResult(session, stepInput);

  const authorizationRequiredRequestIds = new Set(approvals.responseAuthRequiredRequestIds);
  const requests = new Map(approvals.requests.map((request) => [request.requestId, request]));
  const challenges: AuthorizationChallenge[] = [];
  const feedback: string[] = [];
  const consumed = new Set<string>();
  let didCommit = false;
  const candidatesAtStart = readApprovalCandidates(session.state);

  const deliveredResponses = [
    ...(stepInput?.attributedInputResponses ?? []),
    ...(stepInput?.inputResponses ?? []).map((response) => ({ auth: undefined, response })),
  ];
  for (const { auth: attributedResponder, response } of deliveredResponses) {
    const request = requests.get(response.requestId);
    if (request === undefined || !isApprovalRequest(request)) continue;

    const requiresAuthorization = authorizationRequiredRequestIds.has(response.requestId);
    if (!requiresAuthorization) {
      const context = contextStorage.getStore();
      const responder =
        attributedResponder !== undefined
          ? attributedResponder
          : (context?.get(AuthKey) ?? context?.get(SessionKey)?.auth.current ?? null);
      const decision = toCandidateDecision(response.optionId);
      if (responder !== null && decision !== undefined) {
        const settled = settleDirectApprovalResponse({
          actor: responder,
          at,
          decision,
          requestId: response.requestId,
          settledAt: now,
          state: session.state,
        });
        events.push(...settled.events);
        session = { ...session, state: settled.state };
        didCommit ||= settled.changed;
      }
      continue;
    }
    consumed.add(response.requestId);

    // A response policy decides Cancel as well as Approve, so a responder it
    // rejects can neither approve nor cancel someone else's request.
    const decision = toCandidateDecision(response.optionId);
    if (decision === undefined) continue;
    const responder =
      attributedResponder !== undefined
        ? attributedResponder
        : buildCallbackContext().session.auth.current;
    if (responder === null) {
      feedback.push(UNAUTHENTICATED_APPROVAL_FEEDBACK);
      continue;
    }

    const created = createApprovalCandidate({
      at,
      candidateIdPrefix: approvalCandidateIdPrefix(request.requestId, responder, decision),
      createdAt: now,
      decision,
      expiresAt: now + APPROVAL_CANDIDATE_TTL_MS,
      requestId: request.requestId,
      responder,
      state: session.state,
    });
    events.push(...created.events);
    session = { ...session, state: created.state };
    didCommit ||= created.changed;
  }

  const remainingStepInput = removeConsumedResponses(stepInput, consumed);
  if (consumed.size > 0) {
    return deliveryResult(
      session,
      remainingStepInput,
      didCommit ? "continue-coordination" : "continue",
      [],
      feedback,
    );
  }
  if (didCommit) {
    return deliveryResult(session, remainingStepInput, "continue", [], feedback);
  }

  // Candidates are persisted in an earlier pass. Run pending candidates and
  // resume only authorization-required candidates whose callback arrived.
  const parkedChallengeNames = new Set(
    getPendingAuthorization(session.state)?.challenges.map((challenge) => challenge.name) ?? [],
  );
  for (const candidate of candidatesAtStart) {
    if (candidate.status === "authorization-required") {
      const candidateChallenges = candidate.authorizationChallenges ?? [];
      const hasCallback = candidateChallenges.some(
        (challenge) => getAuthorizationResult(challenge.name) !== undefined,
      );
      if (!hasCallback) {
        challenges.push(
          ...candidateChallenges.filter((challenge) => !parkedChallengeNames.has(challenge.name)),
        );
        continue;
      }
    }

    const request = requests.get(candidate.requestId);
    if (
      request === undefined ||
      getActiveApprovalCandidate(session.state, candidate.candidateId) === undefined
    ) {
      continue;
    }
    const processed = await authorizeCandidate({
      at,
      candidateId: candidate.candidateId,
      decision: candidate.decision,
      events,
      now,
      request,
      responder: candidate.responder,
      session,
      tools: (await input.prepareTools?.(request)) ?? input.tools,
    });
    session = processed.session;
    didCommit ||= processed.didCommit;
    challenges.push(...processed.challenges);
  }

  const settledApprovals = readSettledApprovals(session.state);
  const resumedStepInput = appendSettledResponses(remainingStepInput, settledApprovals);
  // Only a terminal candidate pass completes response processing. Ingestion must
  // still commit before policy work, and live candidates still own their park.
  if ((didCommit || expired.changed) && readApprovalCandidates(session.state).length === 0) {
    return deliveryResult(session, resumedStepInput, "responses-completed");
  }
  if (settledApprovals.length > 0) {
    return deliveryResult(session, resumedStepInput, "continue");
  }
  return didCommit
    ? deliveryResult(session, resumedStepInput, "continue-coordination")
    : deliveryResult(
        session,
        resumedStepInput,
        challenges.length > 0 ? "authorization-required" : "continue",
        challenges,
      );
}

async function authorizeCandidate(input: {
  readonly at: ApprovalEventCoordinates;
  readonly candidateId: string;
  readonly decision: ApprovalCandidateDecision;
  readonly events: ApprovalCandidateEvent[];
  readonly now: number;
  readonly request: InputRequest;
  readonly responder: ActiveApprovalCandidate["responder"];
  readonly session: HarnessSession;
  readonly tools: HarnessToolMap;
}): Promise<{
  readonly challenges: readonly AuthorizationChallenge[];
  readonly didCommit: boolean;
  readonly session: HarnessSession;
}> {
  // Expiry is checked again immediately before callback/policy execution.
  const expired = expireApprovalCandidates({
    at: input.at,
    now: input.now,
    state: input.session.state,
  });
  input.events.push(...expired.events);
  let session = { ...input.session, state: expired.state };
  if (getActiveApprovalCandidate(session.state, input.candidateId) === undefined) {
    return { challenges: [], didCommit: false, session };
  }

  const approval = input.tools.get(input.request.action.toolName)?.approval;
  const responsePolicy =
    approval !== undefined && typeof approval !== "function" ? approval.response : undefined;
  if (responsePolicy === undefined) {
    return failCandidate({
      ...input,
      reason: "Approval authorization is temporarily unavailable. Please try again.",
      session,
    });
  }

  try {
    const context = buildCallbackContext();
    const outcome = await withAuthorizerTimeout(
      responsePolicy({
        auth: buildApprovalResponseAuth({
          responder: input.responder,
          scope: input.candidateId,
        }),
        request: {
          callId: input.request.action.callId,
          requestId: input.request.requestId,
          principal: openApprovalRequester(session.state, input.request.requestId),
          toolInput: input.request.action.input,
          toolName: input.request.action.toolName,
        },
        response: { decision: input.decision, principal: input.responder },
        session: {
          id: context.session.id,
          initiator: context.session.auth.initiator,
          parent: context.session.parent,
          turn: context.session.turn,
        },
      }),
    );
    if (outcome.status === "rejected") {
      return failCandidate({ ...input, reason: outcome.reason, session, status: "rejected" });
    }
    if (outcome.status !== "allowed") {
      return failCandidate({ ...input, session });
    }

    const settled = settleAllowedCandidate({
      at: input.at,
      candidateId: input.candidateId,
      settledAt: input.now,
      state: session.state,
    });
    input.events.push(...settled.events);
    return {
      challenges: [],
      didCommit: settled.changed,
      session: { ...session, state: settled.state },
    };
  } catch (error) {
    const authorization = await handleApprovalResponsePolicyError(error).catch(() => undefined);
    if (isAuthorizationSignal(authorization)) {
      const providerExpiresAt = authorization.challenges
        .map((entry) => Date.parse(entry.challenge.expiresAt ?? ""))
        .filter(Number.isFinite)
        .sort((a, b) => a - b)[0];
      const challenges = authorization.challenges.map((challenge) => ({
        ...challenge,
        candidateId: input.candidateId,
      }));
      session = {
        ...session,
        state: markApprovalCandidateAuthorizationRequired({
          authorizationChallenges: challenges,
          candidateId: input.candidateId,
          expiresAt: providerExpiresAt,
          state: session.state,
        }),
      };
      return { challenges, didCommit: true, session };
    }
    return failCandidate({ ...input, session });
  }
}

function failCandidate(input: {
  readonly at: ApprovalEventCoordinates;
  readonly candidateId: string;
  readonly events: ApprovalCandidateEvent[];
  readonly reason?: string;
  readonly session: HarnessSession;
  readonly status?: "rejected";
}): {
  readonly challenges: readonly AuthorizationChallenge[];
  readonly didCommit: true;
  readonly session: HarnessSession;
} {
  const finished = finishApprovalCandidate({
    at: input.at,
    candidateId: input.candidateId,
    reason:
      input.status === "rejected"
        ? input.reason
        : (input.reason ?? "We couldn’t verify your response. Please try again."),
    state: input.session.state,
    status: input.status ?? "failed",
  });
  input.events.push(...finished.events);
  return { challenges: [], didCommit: true, session: { ...input.session, state: finished.state } };
}

function appendSettledResponses(
  stepInput: StepInput | undefined,
  settled: ReturnType<typeof readSettledApprovals>,
): StepInput | undefined {
  if (settled.length === 0) return stepInput;
  const existingRequestIds = new Set([
    ...(stepInput?.inputResponses ?? []).map((response) => response.requestId),
    ...(stepInput?.attributedInputResponses ?? []).map(({ response }) => response.requestId),
  ]);
  const missing = settled.filter((approval) => !existingRequestIds.has(approval.requestId));
  if (missing.length === 0) return stepInput;
  return {
    ...stepInput,
    inputResponses: [
      ...(stepInput?.inputResponses ?? []),
      ...missing.map((approval) => ({
        optionId: approval.decision,
        requestId: approval.requestId,
      })),
    ],
  };
}

function removeConsumedResponses(
  stepInput: StepInput | undefined,
  consumed: ReadonlySet<string>,
): StepInput | undefined {
  if (stepInput === undefined) return undefined;
  const attributed = (stepInput.attributedInputResponses ?? []).filter(
    ({ response }) => !consumed.has(response.requestId),
  );
  const plain = (stepInput.inputResponses ?? []).filter(
    (response) => !consumed.has(response.requestId),
  );
  const inputResponses = [...plain, ...attributed.map(({ response }) => response)];
  return {
    ...stepInput,
    attributedInputResponses: undefined,
    inputResponses,
  };
}

function deliveryResult(
  session: HarnessSession,
  stepInput: StepInput | undefined,
  kind: ApprovalDeliveryResult["kind"] = "continue",
  challenges: readonly AuthorizationChallenge[] = [],
  feedback: readonly string[] = [],
): Omit<ApprovalDeliveryResult, "events"> {
  return { challenges, feedback, kind, session, stepInput };
}

function toCandidateDecision(optionId: string | undefined): ApprovalCandidateDecision | undefined {
  if (optionId === "approve") return "approve";
  // ACP's Deny button sends "deny" where eve's own prompts send "cancel".
  if (optionId === "cancel" || optionId === "deny") return "cancel";
  return undefined;
}

function approvalCandidateIdPrefix(
  requestId: string,
  responder: SessionAuthContext,
  decision: ApprovalCandidateDecision,
): string {
  const principal = [
    responder.authenticator,
    responder.issuer ?? "",
    responder.principalType,
    responder.principalId,
  ].join(":");
  const prefix = `${encodeCandidateIdPart(requestId)}.${encodeCandidateIdPart(principal)}`;
  // Approve keeps its established id; Cancel needs its own so both can be pending.
  return decision === "approve" ? prefix : `${prefix}.${encodeCandidateIdPart(decision)}`;
}

function encodeCandidateIdPart(value: string): string {
  return Array.from(value, (character) => character.codePointAt(0)!.toString(36)).join("-");
}

async function withAuthorizerTimeout<T>(promise: Promise<T> | T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Approval response authorizer timed out.")),
          APPROVAL_AUTHORIZER_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
