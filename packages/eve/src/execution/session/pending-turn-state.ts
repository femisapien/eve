import { getPendingCoordinationBatch, pendingCoordinationCallIds } from "#harness/coordination.js";
import { pendingTaskToolCalls, type TaskToolCall } from "#execution/tasks/calls.js";
import type { HarnessSession } from "#harness/types.js";

/** Derives the workflow fields used to select the next action at the park boundary. */
export function derivePendingState(session: HarnessSession): {
  readonly pendingCoordinationCallIds?: readonly string[];
  readonly pendingTaskToolCalls?: readonly TaskToolCall[];
} {
  const batch = getPendingCoordinationBatch(session.state);
  if (batch === undefined) return {};
  return {
    pendingCoordinationCallIds: pendingCoordinationCallIds(batch),
    pendingTaskToolCalls: pendingTaskToolCalls(batch.responseMessages),
  };
}
