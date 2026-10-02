import {
  reportApprovalProgress,
  retireActiveCandidates,
  type ApprovalEventCoordinates,
  type ApprovalProgressEvent,
} from "#harness/approval-candidates.js";
import { authorizationEventFields } from "#harness/authorization-event-fields.js";
import {
  clearPendingAuthorization,
  getPendingAuthorization,
  type AuthorizationChallenge,
} from "#harness/authorization.js";
import { createAuthorizationCompletedEvent } from "#protocol/message.js";

/**
 * Ends the sign-ins a held turn waits on when the person moves on, by steering
 * it with a message or cancelling it: the turn's own sign-ins, and the sign-ins
 * of responders still checking one of its approvals, whose candidates end as
 * stale. The approvals themselves resolve with the steering step or the cancel.
 * Returns the events to emit now: each withdrawn sign-in declined, then each
 * stale candidate.
 */
export function withdrawHeldSignIns(
  state: Record<string, unknown> | undefined,
  input: { readonly emissionState: ApprovalEventCoordinates; readonly reason: string },
): {
  readonly events: readonly ApprovalProgressEvent[];
  readonly state: Record<string, unknown> | undefined;
  readonly withdrawn: readonly AuthorizationChallenge[];
} {
  const withdrawn = getPendingAuthorization(state)?.challenges ?? [];
  const declined = withdrawn.map((challenge) =>
    createAuthorizationCompletedEvent({
      ...authorizationEventFields(challenge),
      outcome: "declined",
      reason: input.reason,
      sequence: input.emissionState.sequence,
      stepIndex: input.emissionState.stepIndex,
      turnId: input.emissionState.turnId,
    }),
  );
  const retired = retireActiveCandidates(
    withdrawn.length === 0 ? state : clearPendingAuthorization(state),
    { completedAt: Date.now(), reason: input.reason },
  );
  const reported = reportApprovalProgress(retired, { at: input.emissionState, challenges: [] });
  return { events: [...declined, ...reported.events], state: reported.state, withdrawn };
}
