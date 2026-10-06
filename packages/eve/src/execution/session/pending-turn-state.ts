import type { TaskToolCall } from "#execution/tasks/calls.js";
import { HumanInput } from "#harness/hitl/index.js";
import type { HarnessSession } from "#harness/types.js";

/** Derives the workflow fields used to select the next action at the park boundary. */
export function derivePendingState(session: HarnessSession): {
  /** The pending batch has workflow tool runs to start; task tool calls are answered by the session. */
  readonly hasRunsToDispatch?: boolean;
  readonly pendingCoordinationCallIds?: readonly string[];
  readonly pendingTaskToolCalls?: readonly TaskToolCall[];
} {
  const held = HumanInput.read(session.state).runtimeCalls();
  if (held === undefined) return {};
  return {
    hasRunsToDispatch: held.tasks.length > 0,
    pendingCoordinationCallIds: held.calls
      .filter((call) => call.waitsOn === "runtime")
      .map((call) => call.callId),
    pendingTaskToolCalls: held.taskToolCalls,
  };
}
