import { createDurableSessionValues } from "#execution/durable-session-store.js";
import { derivePendingState } from "#execution/session/pending-turn-state.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import { HumanInput } from "#harness/hitl/index.js";
import { getTurnUsageState, takeSessionUsageDelta, toUsage } from "#harness/turn-tag-state.js";
import type { StepResult } from "#harness/types.js";

export function resolveSessionStepResult(
  stepResult: StepResult,
  nextSerializedContext: Record<string, unknown>,
): DurableStepResult {
  const values = {
    serializedContext: nextSerializedContext,
    ...createDurableSessionValues(stepResult.session),
  };
  if (stepResult.steered) return { action: "steered", ...values };

  if (
    stepResult.next !== null &&
    typeof stepResult.next === "object" &&
    "done" in stepResult.next
  ) {
    const sessionTotals = getTurnUsageState(stepResult.session.state)?.session;
    return {
      action: "done",
      output: stepResult.next.output,
      isError: stepResult.next.isError,
      ...values,
      usage: sessionTotals === undefined ? undefined : toUsage(sessionTotals),
      usageDelta: takeSessionUsageDelta(stepResult.session).delta,
    };
  }

  if (stepResult.waiting?.kind === "tasks") {
    return { action: "held", hold: "tasks", ...values, taskIds: stepResult.waiting.taskIds };
  }
  if (stepResult.waiting?.kind === "input") {
    const humanInput = HumanInput.read(stepResult.session.state);
    return {
      action: "held",
      authorizationAttemptIds: humanInput.awaitedAuthorizations(),
      hold: "input",
      inputRequestIds: [...humanInput.openRequestIds()],
      ...values,
    };
  }
  if (stepResult.next === null) {
    const { hasRunsToDispatch, pendingCoordinationCallIds, pendingTaskToolCalls } =
      derivePendingState(stepResult.session);
    const pending = { hasRunsToDispatch, pendingCoordinationCallIds, pendingTaskToolCalls };

    // Usage stays unreported until the turn settles, so the caller's result includes all of it.
    if (stepResult.settledTurn !== undefined) {
      const { delta, session: reportedSession } = takeSessionUsageDelta(stepResult.session);
      return {
        action: "park",
        ...pending,
        serializedContext: nextSerializedContext,
        ...createDurableSessionValues(reportedSession),
        settled: {
          output: stepResult.settledTurn.output,
          isError: stepResult.settledTurn.isError,
          usage: delta,
        },
      };
    }

    return { action: "park", ...pending, ...values };
  }

  return {
    action: "continue",
    ...(stepResult.readsResults === true && { readsResults: true }),
    ...values,
  };
}
