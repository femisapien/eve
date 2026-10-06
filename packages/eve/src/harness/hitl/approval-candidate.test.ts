import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { Input, PolicyRun } from "#harness/hitl/index.js";
import {
  ALICE,
  AT,
  BOB,
  CAROL,
  NOW,
  Turn,
  answer,
  approval,
  approvalsRequested,
  callback,
  cancel,
  challenge,
  message,
} from "#internal/testing/hitl.js";

/** A turn waiting on Alice's approval of `deploy`, whose response policy decides who may answer. */
function guarded(): Turn {
  return Turn.idle().input(
    approvalsRequested([approval("deploy")], { responsePolicyRequestIds: ["deploy"] }),
  );
}

function answerAs(responder: SessionAuthContext | null, optionId = "approve"): Input {
  return answer(optionId, "deploy", responder);
}

/** The candidate whose policy the runtime runs before it commits `input`. */
function checkedId(turn: Turn, input: Input): string {
  return turn.checks(input).at(-1)!.candidateId;
}

const ALLOWED: PolicyRun = { kind: "returned", value: { status: "allowed" } };

function candidates(turn: Turn) {
  return turn.published("approval.candidate").map(({ data }) => ({
    outcome: data.outcome,
    reason: data.reason,
    responder: data.responderPrincipalId,
  }));
}

/**
 * Bob answered `turn`'s approval, and his policy asks him to authorize to
 * "reviewer" first, at a provider that accepts the callback until `expiresAt`.
 */
function bobMustAuthorize(turn = guarded(), expiresAt?: string): Turn {
  return turn.checked(answerAs(BOB), {
    challenges: [
      challenge("r1", {
        name: "reviewer",
        principalId: "bob",
        requester: BOB,
        ...(expiresAt !== undefined && {
          challenge: { expiresAt, url: "https://idp.example/authorize/r1" },
        }),
      }),
    ],
    kind: "threw",
  });
}

describe("approval response policies", () => {
  it("an answer is committed only with what the policy did, as its responder", () => {
    const turn = guarded();

    expect(turn.checks(answerAs(BOB))).toEqual([
      expect.objectContaining({
        at: AT,
        decision: "approve",
        request: approval("deploy"),
        requester: ALICE,
        responder: BOB,
      }),
    ]);
    expect(() => turn.input(answerAs(BOB))).toThrow(/run its policyChecks first/);
  });

  it("typed text never answers a guarded approval; it steers past it", () => {
    const turn = guarded().input(message("approve"));

    expect(turn.reported("consumeMessage")).toEqual([]);
    expect(turn.resolutions().map(({ outcome }) => outcome)).toEqual(["ignored"]);
  });

  it("the first allowed candidate settles the approval, and its competitors go stale", () => {
    const turn = bobMustAuthorize().checked(answerAs(CAROL), ALLOWED);

    expect(candidates(turn)).toEqual([
      { outcome: "pending", reason: undefined, responder: "carol" },
      { outcome: "stale", reason: "Another response settled this approval.", responder: "bob" },
    ]);
    expect(turn.published("approval.settled").map(({ data }) => data)).toEqual([
      expect.objectContaining({ outcome: "approved", responderPrincipalId: "carol" }),
    ]);
    expect(turn.next()).toEqual({ run: "approved" });
    expect(turn.approvedCalls()).toEqual({ at: AT, requests: [approval("deploy")] });
  });

  it("time is committed first, so a candidate that expired never runs its policy", () => {
    const authorization = bobMustAuthorize();
    const late = authorization.input({ now: NOW + 10 * 60_000, type: "time" });

    expect(authorization.checks(callback("r1", "reviewer"))).toHaveLength(1);
    expect(late.checks(callback("r1", "reviewer"))).toEqual([]);
  });

  it("an allowed Cancel settles the approval as denied, and the call never runs", () => {
    const turn = guarded().checked(answerAs(ALICE, "cancel"), ALLOWED);

    expect(turn.published("approval.settled")[0]?.data.outcome).toBe("cancelled");
    expect(turn.resolutions().map(({ outcome }) => outcome)).toEqual(["denied"]);
    expect(turn.next()).toEqual({ run: "model" });
  });

  it("a rejected candidate leaves the approval open, and a retry is a fresh candidate", () => {
    const rejected = guarded().checked(answerAs(BOB), {
      kind: "returned",
      value: { reason: "Wrong responder.", status: "rejected" },
    });

    expect(candidates(rejected)).toEqual([
      { outcome: "pending", reason: undefined, responder: "bob" },
      { outcome: "rejected", reason: "Wrong responder.", responder: "bob" },
    ]);
    expect(rejected.next()).toEqual({ waiting: "input" });
    expect(checkedId(rejected.stored(), answerAs(BOB))).not.toBe(
      checkedId(guarded(), answerAs(BOB)),
    );
  });

  it("a repeat of an active candidate is ignored, but a changed decision is a new candidate", () => {
    const answered = bobMustAuthorize();

    expect(answered.checks(answerAs(BOB))).toEqual([]);
    expect(answered.input(answerAs(BOB)).events).toEqual([]);
    expect(answered.checks(answerAs(BOB, "cancel"))).toHaveLength(1);
  });

  it("an answer from nobody authorized is refused", () => {
    expect(guarded().checks(answerAs(null))).toEqual([]);
    const turn = guarded().input(answerAs(null));

    expect(turn.published("message.completed").map(({ data }) => data.message)).toEqual([
      "Authentication is required to respond to this approval.",
    ]);
  });

  it("a policy that failed fails its candidate and leaves the approval open", () => {
    const turn = guarded().checked(answerAs(BOB), { kind: "threw" });

    expect(candidates(turn)).toEqual([
      { outcome: "pending", reason: undefined, responder: "bob" },
      {
        outcome: "failed",
        reason: "We couldn’t verify your response. Please try again.",
        responder: "bob",
      },
    ]);
    expect(turn.next()).toEqual({ waiting: "input" });
  });

  it("a policy that asks the responder to authorize waits on it, then checks again as them", () => {
    const candidateId = checkedId(guarded(), answerAs(BOB));
    const authorization = bobMustAuthorize();

    expect(authorization.published("authorization.required")[0]?.data).toMatchObject({
      attemptId: "r1",
      candidateId,
      principalId: "bob",
    });
    expect(authorization.humanInput.awaitedAuthorizations()).toEqual(["r1"]);

    // The policy reads the callback; the turn keeps Alice as its person.
    expect(authorization.checks(callback("r1", "reviewer"))).toEqual([
      expect.objectContaining({
        authorizations: [expect.objectContaining({ attemptId: "r1", name: "reviewer" })],
        candidateId,
        responder: BOB,
      }),
    ]);
    const turn = authorization.checked(callback("r1", "reviewer"), ALLOWED);
    expect(turn.reported("resumeAuthorization")).toEqual([]);
    expect(turn.published("approval.settled").map(({ data }) => data.responderPrincipalId)).toEqual(
      ["bob"],
    );
  });

  it("a policy that asks for two authorizations reads both callbacks, though they arrive apart", () => {
    const twice = guarded().checked(answerAs(BOB), {
      challenges: [
        challenge("r1", { name: "reviewer", principalId: "bob", requester: BOB }),
        challenge("g1", { name: "github", principalId: "bob", requester: BOB }),
      ],
      kind: "threw",
    });

    expect(twice.checks(callback("r1", "reviewer"))).toEqual([]);
    const first = twice.input(callback("r1", "reviewer")).stored();
    expect(first.reported("resumeAuthorization")).toEqual([]);
    expect(first.humanInput.awaitedAuthorizations()).toEqual(["g1"]);

    expect(first.checks(callback("g1", "github"))).toEqual([
      expect.objectContaining({
        authorizations: [
          expect.objectContaining({ attemptId: "r1", name: "reviewer" }),
          expect.objectContaining({ attemptId: "g1", name: "github" }),
        ],
        responder: BOB,
      }),
    ]);
    const turn = first.checked(callback("g1", "github"), ALLOWED);
    expect(turn.published("approval.settled").map(({ data }) => data.responderPrincipalId)).toEqual(
      ["bob"],
    );
  });

  describe("a candidate that finishes with one of two authorizations completed", () => {
    /** Bob's policy asked for two authorizations, and the first one completed. */
    function halfAuthorized(): Turn {
      return guarded()
        .checked(answerAs(BOB), {
          challenges: [
            challenge("r1", { name: "reviewer", principalId: "bob", requester: BOB }),
            challenge("g1", { name: "github", principalId: "bob", requester: BOB }),
          ],
          kind: "threw",
        })
        .input(callback("r1", "reviewer"))
        .stored();
    }
    /** What the session keeps of its candidates, as stored. */
    function audit(turn: Turn) {
      return (
        turn.stored().state?.["eve.harness.humanInput"] as
          | {
              readonly audit?: {
                readonly activeCandidates: object;
                readonly candidateHistory: object[];
              };
            }
          | undefined
      )?.audit;
    }

    it("keeps the completed callback on the candidate while it waits", () => {
      expect(JSON.stringify(audit(halfAuthorized()))).toContain("callback/r1");
    });

    it.each([
      ["times out", (turn: Turn) => turn.input({ now: NOW + 10 * 60_000 + 1, type: "time" })],
      ["is cancelled", (turn: Turn) => turn.input(cancel)],
      ["is steered past", (turn: Turn) => turn.input(message("Never mind."))],
      ["loses to another candidate", (turn: Turn) => turn.checked(answerAs(CAROL), ALLOWED)],
    ])("leaves no callback in the audit once it %s", (_name, end) => {
      const ended = end(halfAuthorized());
      const kept = audit(ended);

      expect(JSON.stringify(kept ?? {})).not.toContain("authorized");
      expect(JSON.stringify(kept ?? {})).not.toContain("callback/r1");
      expect(Object.keys(kept?.activeCandidates ?? {})).toEqual([]);
    });
  });

  it("a responder's authorization belongs to its candidate, not to the turn's requests", () => {
    const authorization = bobMustAuthorize().stored();
    const stored = authorization.state!["eve.harness.humanInput"] as {
      readonly audit: {
        readonly activeCandidates: Record<string, { readonly authorizations?: unknown[] }>;
      };
      readonly requests: Record<string, unknown>;
    };

    expect(Object.keys(stored.requests)).toEqual(["deploy"]);
    expect(
      Object.values(stored.audit.activeCandidates).map((c) => c.authorizations?.length),
    ).toEqual([1]);
    // A callback for it settles only the candidate; the approval stays open when its policy fails.
    const turn = authorization.checked(callback("r1", "reviewer"), { kind: "threw" }).stored();
    expect(turn.humanInput.awaitedAuthorizations()).toEqual([]);
    expect(turn.humanInput.openRequestIds()).toEqual(new Set(["deploy"]));
  });

  it("a session stored while a responder's authorization was a request of its own reads it as the candidate's", () => {
    const authorization = bobMustAuthorize().stored();
    const answered = authorization.state!["eve.harness.humanInput"] as {
      readonly audit: { readonly activeCandidates: Record<string, Record<string, unknown>> };
      readonly requests: Record<string, unknown>;
    };
    const [[candidateId, candidate]] = Object.entries(answered.audit.activeCandidates) as [
      [string, { readonly authorizations: unknown[] }],
    ];
    const { authorizations, ...waiting } = candidate;
    const legacy = Turn.from({
      "eve.harness.humanInput": {
        ...answered,
        audit: { ...answered.audit, activeCandidates: { [candidateId]: waiting } },
        requests: {
          ...answered.requests,
          r1: { at: AT, challenge: authorizations[0], kind: "authorization" },
        },
      },
    });

    expect(legacy.humanInput.awaitedAuthorizations()).toEqual(["r1"]);
    expect(legacy.humanInput.openRequestIds()).toEqual(new Set(["deploy"]));
    expect(legacy.checks(callback("r1", "reviewer"))).toEqual([
      expect.objectContaining({ candidateId, responder: BOB }),
    ]);
  });

  it("a candidate times out after ten minutes, failing its authorization and ignoring its callback", () => {
    const authorization = bobMustAuthorize();

    expect(authorization.input({ now: NOW + 10 * 60_000 - 1, type: "time" }).events).toEqual([]);
    const turn = authorization.input({ now: NOW + 10 * 60_000, type: "time" });

    expect(candidates(turn)).toEqual([
      { outcome: "timed-out", reason: undefined, responder: "bob" },
    ]);
    expect(turn.published("authorization.completed").map(({ data }) => data)).toEqual([
      expect.objectContaining({
        outcome: "failed",
        reason: "The approval response expired. Please submit a new response.",
      }),
    ]);
    expect(turn.humanInput.openRequestIds()).toEqual(new Set(["deploy"]));
    expect(turn.input(callback("r1", "reviewer")).events).toEqual([]);
  });

  it("a candidate waits no longer than the provider accepts its authorization's callback", () => {
    const authorization = bobMustAuthorize(guarded(), new Date(NOW + 60_000).toISOString());

    expect(authorization.input({ now: NOW + 60_000 - 1, type: "time" }).events).toEqual([]);
    const late = authorization.input({ now: NOW + 5 * 60_000, type: "time" });
    expect(candidates(late)).toEqual([
      { outcome: "timed-out", reason: undefined, responder: "bob" },
    ]);
    expect(late.checks(callback("r1", "reviewer"))).toEqual([]);
    expect(late.input(callback("r1", "reviewer")).events).toEqual([]);
  });

  it.each([
    { expiresAt: new Date(NOW + 60 * 60_000).toISOString(), name: "a later provider expiry" },
    { expiresAt: "not a date", name: "an unreadable provider expiry" },
  ])("$name never extends a candidate's ten minutes", ({ expiresAt }) => {
    const authorization = bobMustAuthorize(guarded(), expiresAt);

    expect(authorization.input({ now: NOW + 10 * 60_000 - 1, type: "time" }).events).toEqual([]);
    const turn = authorization.input({ now: NOW + 10 * 60_000, type: "time" });
    expect(candidates(turn).map(({ outcome }) => outcome)).toEqual(["timed-out"]);
  });

  it.each([
    { input: message("Never mind, just say hello."), name: "a message" },
    { input: cancel, name: "a cancel" },
  ])("$name stales active candidates and declines their authorizations silently", ({ input }) => {
    const turn = bobMustAuthorize().input(input);

    expect(candidates(turn).map(({ outcome }) => outcome)).toEqual(["stale"]);
    expect(turn.published("authorization.completed").map(({ data }) => data.outcome)).toEqual([
      "declined",
    ]);
    // Only the turn's own authorizations are named to the model.
    expect(turn.reported("addNote")).toEqual([]);
    expect(turn.next()).toEqual({ run: "model" });
  });
});
