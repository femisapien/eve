import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  createApprovalCandidate,
  expireApprovalCandidates,
  finishApprovalCandidate,
  markApprovalCandidateAuthorizationRequired,
  readApprovalCandidates,
  readSettledApprovals,
  settleAllowedCandidate,
  settleDirectApprovalResponse,
} from "#harness/approval-candidates.js";
import { openTurnInputRequest } from "#harness/open-input-requests.js";
import type { SessionStateMap } from "#harness/types.js";

const at = { sequence: 3, stepIndex: 1, turnId: "turn-1" };

function responder(principalId: string): SessionAuthContext {
  return {
    attributes: { workspace: "T1" },
    authenticator: "slack-webhook",
    issuer: "slack:T1",
    principalId,
    principalType: "user",
  };
}

function openApprovals(...requestIds: string[]): SessionStateMap | undefined {
  let session: { readonly state?: SessionStateMap } = {};
  for (const requestId of requestIds) {
    session = openTurnInputRequest(session, {
      event: at,
      request: {
        action: { callId: `call-${requestId}`, input: {}, kind: "tool-call", toolName: "gate" },
        kind: "tool-approval",
        prompt: "Approve tool call: gate",
        requestId,
      },
    });
  }
  return session.state;
}

function create(input: {
  readonly candidateId: string;
  readonly principalId: string;
  readonly requestId?: string;
  readonly state?: SessionStateMap;
}) {
  return createApprovalCandidate({
    at,
    candidateIdPrefix: input.candidateId,
    createdAt: 100,
    decision: "approve",
    expiresAt: 700,
    requestId: input.requestId ?? "request-1",
    responder: responder(input.principalId),
    state: input.state ?? openApprovals("request-1", "request-2"),
  });
}

function candidateEvent(candidateId: string, outcome: string, data: object = {}) {
  return {
    data: expect.objectContaining({ ...data, candidateId, outcome }),
    type: "approval.candidate",
  };
}

describe("approval candidate state", () => {
  it("keeps the complete responder on the approval while a candidate is active", () => {
    const transition = create({ candidateId: "candidate-1", principalId: "U1" });

    expect(transition.changed).toBe(true);
    expect(readApprovalCandidates(transition.state)).toEqual([
      {
        candidateId: "candidate-1",
        createdAt: 100,
        decision: "approve",
        expiresAt: 700,
        requestId: "request-1",
        responder: {
          attributes: { workspace: "T1" },
          authenticator: "slack-webhook",
          issuer: "slack:T1",
          principalId: "U1",
          principalType: "user",
        },
        status: "pending",
      },
    ]);
    expect(transition.events).toEqual([
      {
        data: {
          candidateId: "candidate-1",
          outcome: "pending",
          requestId: "request-1",
          responderPrincipalId: "U1",
          ...at,
        },
        type: "approval.candidate",
      },
    ]);
  });

  it("silently deduplicates one responder's active candidate", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const duplicate = create({
      candidateId: "candidate-1",
      principalId: "U1",
      state: first.state,
    });

    expect(duplicate.changed).toBe(false);
    expect(duplicate.events).toEqual([]);
    expect(duplicate.state).toBe(first.state);
  });

  it("defensively deduplicates the same responder under another id", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const duplicate = create({
      candidateId: "candidate-2",
      principalId: "U1",
      state: first.state,
    });

    expect(duplicate.changed).toBe(false);
  });

  it("allows different responders to validate concurrently", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const second = create({
      candidateId: "candidate-2",
      principalId: "U2",
      state: first.state,
    });

    expect(second.changed).toBe(true);
    expect(readApprovalCandidates(second.state)).toHaveLength(2);
  });

  it("ignores a response for a request that is no longer open", () => {
    const state = openApprovals("request-2");
    const transition = create({ candidateId: "candidate-1", principalId: "U1", state });

    expect(transition).toEqual({ changed: false, events: [], state });
  });

  it("tracks authorization-required state and provider expiry", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const state = markApprovalCandidateAuthorizationRequired({
      authorizationChallenges: [],
      candidateId: "candidate-1",
      expiresAt: 500,
      state: first.state,
    });

    expect(readApprovalCandidates(state)[0]).toMatchObject({
      expiresAt: 500,
      status: "authorization-required",
    });
  });

  it("reports safe rejection feedback and permits a later retry under a fresh id", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const rejected = finishApprovalCandidate({
      at,
      candidateId: "candidate-1",
      reason: "GitHub write permission is required.",
      state: first.state,
      status: "rejected",
    });
    const retry = create({
      candidateId: "candidate-1",
      principalId: "U1",
      state: rejected.state,
    });

    expect(rejected.events).toEqual([
      candidateEvent("candidate-1", "rejected", {
        reason: "GitHub write permission is required.",
      }),
    ]);
    expect(retry.changed).toBe(true);
    expect(readApprovalCandidates(retry.state).map((candidate) => candidate.candidateId)).toEqual([
      "candidate-1.1",
    ]);
  });

  it("expires stale candidates intrinsically before creating another candidate", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const next = createApprovalCandidate({
      at,
      candidateIdPrefix: "candidate-2",
      createdAt: 800,
      decision: "approve",
      expiresAt: 1_400,
      requestId: "request-1",
      responder: responder("U2"),
      state: first.state,
    });

    expect(readApprovalCandidates(next.state)).toEqual([
      expect.objectContaining({ candidateId: "candidate-2.1" }),
    ]);
    expect(next.events).toEqual([
      candidateEvent("candidate-1", "timed-out"),
      candidateEvent("candidate-2.1", "pending"),
    ]);
  });

  it("expires only candidates whose deadline has passed", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const second = createApprovalCandidate({
      at,
      candidateIdPrefix: "candidate-2",
      createdAt: 100,
      decision: "approve",
      expiresAt: 900,
      requestId: "request-1",
      responder: responder("U2"),
      state: first.state,
    });
    const expired = expireApprovalCandidates({ at, now: 800, state: second.state });

    expect(readApprovalCandidates(expired.state).map((candidate) => candidate.candidateId)).toEqual(
      ["candidate-2.1"],
    );
    expect(expired.events).toEqual([candidateEvent("candidate-1", "timed-out")]);
  });

  it("atomically settles the first allowed candidate and stales competitors", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const second = create({
      candidateId: "candidate-2",
      principalId: "U2",
      state: first.state,
    });
    const winner = settleAllowedCandidate({
      at,
      candidateId: "candidate-2.1",
      settledAt: 300,
      state: second.state,
    });
    const late = settleAllowedCandidate({
      at,
      candidateId: "candidate-1",
      settledAt: 400,
      state: winner.state,
    });

    expect(winner.changed).toBe(true);
    expect(winner.events).toEqual([
      candidateEvent("candidate-1", "stale"),
      {
        data: {
          outcome: "approved",
          requestId: "request-1",
          responderPrincipalId: "U2",
          ...at,
        },
        type: "approval.settled",
      },
    ]);
    expect(late).toEqual({ changed: false, events: [], state: winner.state });
    expect(readApprovalCandidates(late.state)).toEqual([]);
    expect(readSettledApprovals(late.state)).toEqual([
      { decision: "approve", requestId: "request-1" },
    ]);
  });

  it("lets Cancel win atomically and stales every Allow candidate", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const cancelled = settleDirectApprovalResponse({
      actor: responder("U2"),
      at,
      decision: "cancel",
      requestId: "request-1",
      settledAt: 250,
      state: first.state,
    });
    const late = settleAllowedCandidate({
      at,
      candidateId: "candidate-1",
      settledAt: 300,
      state: cancelled.state,
    });

    expect(cancelled.changed).toBe(true);
    expect(cancelled.events.map((event) => event.type)).toEqual([
      "approval.candidate",
      "approval.settled",
    ]);
    expect(late.changed).toBe(false);
  });

  it("does not let a candidate start after terminal settlement", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const settled = settleAllowedCandidate({
      at,
      candidateId: "candidate-1",
      settledAt: 300,
      state: first.state,
    });
    const late = create({
      candidateId: "candidate-2",
      principalId: "U2",
      state: settled.state,
    });

    expect(late.changed).toBe(false);
    expect(late.events).toEqual([]);
  });

  it("keeps unrelated requests active when another request settles", () => {
    const first = create({ candidateId: "candidate-1", principalId: "U1" });
    const unrelated = create({
      candidateId: "candidate-2",
      principalId: "U2",
      requestId: "request-2",
      state: first.state,
    });
    const settled = settleAllowedCandidate({
      at,
      candidateId: "candidate-1",
      settledAt: 300,
      state: unrelated.state,
    });

    expect(readApprovalCandidates(settled.state)).toEqual([
      expect.objectContaining({ candidateId: "candidate-2", requestId: "request-2" }),
    ]);
  });
});
