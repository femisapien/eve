import { getPendingAuthorization } from "#harness/authorization.js";
import { getPendingCoordinationBatch, pendingCoordinationCallIds } from "#harness/coordination.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { ownOpenRequestIds } from "#harness/session-machine/transitions.js";
import { pendingTaskToolCalls, type TaskToolCall } from "#execution/tasks/calls.js";
import type { HarnessSession } from "#harness/types.js";
import { openSignIns, type SessionProjection } from "#protocol/session-projection.js";

/**
 * Derives the workflow fields used to select the next action at the park boundary. Whether the
 * session awaits input or a sign-in is the projection's; which callbacks resume it, and which
 * calls wait on the runtime, is execution state.
 */
export function derivePendingState(
  session: HarnessSession,
  projection: SessionProjection,
): {
  readonly authorizationAttemptIds?: readonly string[];
  readonly hasPendingAuthorization: boolean;
  readonly hasPendingInputBatch: boolean;
  readonly pendingCoordinationCallIds?: readonly string[];
  readonly pendingTaskToolCalls?: readonly TaskToolCall[];
} {
  const batch = getPendingCoordinationBatch(session.state);
  const pendingAuth = getPendingAuthorization(session.state);
  const base = {
    authorizationAttemptIds: pendingAuth?.challenges.flatMap((challenge) =>
      challenge.attemptId === undefined ? [] : [challenge.attemptId],
    ),
    hasPendingAuthorization: openSignIns(projection).length > 0,
    hasPendingInputBatch: ownOpenRequestIds(sessionView(projection, session.state)).size > 0,
  };
  if (batch === undefined) return base;
  return {
    ...base,
    pendingCoordinationCallIds: pendingCoordinationCallIds(batch),
    pendingTaskToolCalls: pendingTaskToolCalls(batch.responseMessages),
  };
}
