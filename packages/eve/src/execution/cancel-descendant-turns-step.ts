import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { cancelWorkflowToolRun } from "#execution/tools/workflow/cancel.js";
import { readTurnState, workflowRuns } from "#harness/turn-state.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.cancel-descendant-turns");

/** Cancels every workflow tool run the turn is waiting on. */
export async function cancelDescendantTurnsStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  let runs: ReturnType<typeof workflowRuns>;
  try {
    runs = workflowRuns(readTurnState(readDurableSession(input.sessionState).state));
  } catch (error) {
    logError(log, "failed to read pending descendants during cancellation", error, {
      sessionId: input.sessionState.sessionId,
    });
    return;
  }

  await Promise.all(
    runs.map((record) =>
      cancelWorkflowToolRun(record.address, {
        kind: "cancel",
        reason: "The turn that called the tool was cancelled.",
      }),
    ),
  );
}
