import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import {
  publishFromSessionStep,
  relaySessionEvents,
  restoreSessionStep,
  type SessionHistoryStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { emitCancelledTurn } from "#harness/cancelled-turn-emission.js";
import { HumanInput } from "#harness/human-input/index.js";
import { type HarnessModelMessage, validateHarnessModelMessages } from "#harness/messages.js";
import { cancelParkedTurn } from "#harness/human-input/effects/index.js";
import { getHarnessEmissionState, setHarnessEmissionState } from "#harness/emission.js";
import { removeBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import {
  getSessionUsage,
  getTurnUsageState,
  takeSessionUsageDelta,
} from "#harness/turn-tag-state.js";
import type { TokenUsage } from "#shared/token-usage.js";

export interface CancelledTurnSettleResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly history: HarnessModelMessage[];
  /** What the session spent since its caller's last report, when asked to report it. */
  readonly usage?: TokenUsage;
}

/** Takes the history because the turn's pending calls move into it, each answered as cancelled. */
interface CancelledTurnSettleInput extends SessionHistoryStepState {
  /**
   * Whether a caller receives the turn's usage. Only then is it marked
   * reported; otherwise the next settled turn reports it.
   */
  readonly reportUsage: boolean;
}

/**
 * Settles one cancelled turn: tells human input the turn was cancelled, emits
 * `turn.cancelled` → `session.waiting`, drops the runs the turn waited on, and
 * persists the between-turns session. Runs in the owner, whose wake sources
 * exclude the cancel hook, so a queued cancel wake cannot re-dispatch it.
 */
export async function settleCancelledTurnStep(
  input: CancelledTurnSettleInput,
): Promise<WithSessionStateDelta<CancelledTurnSettleResult>> {
  "use step";
  return await withSessionStateDelta(input, settleCancelledTurn);
}

/** {@link settleCancelledTurnStep} for a caller that is already a step and adopts the whole state. */
export async function settleCancelledTurn(
  input: CancelledTurnSettleInput,
): Promise<CancelledTurnSettleResult> {
  const parked = readDurableSession(input.sessionState);
  // The turn that made the held step's calls owns the runs they started.
  const owningTurnId =
    HumanInput.read(parked.state).heldStep()?.at.turnId ?? input.sessionState.emissionState.turnId;
  // The held step joins history with each call it waited on answered as not run.
  const cancelled = await cancelParkedTurn(parked);
  // The cancel stopped every child and run, so channels stop offering what they asked.
  const withdrawn = await relaySessionEvents(
    {
      ...input,
      sessionState: replaceDurableSessionSnapshot({
        session: cancelled.session,
        state: input.sessionState,
      }),
    },
    cancelled.relayed,
  );
  const step = {
    ...(await restoreSessionStep({ ...withdrawn, sessionWritable: input.sessionWritable })),
    history: input.history,
  };
  const durableState = step.durableSession.state;
  const { published, result: usage } = await publishFromSessionStep(step, {
    origin: "own",
    async publish(emit) {
      for (const event of cancelled.own) await emit(event);
      const emissionState = getHarnessEmissionState(durableState);
      return await emitCancelledTurn(emit, emissionState, getSessionUsage(step.durableSession));
    },
    updateSession(session, emissionState) {
      const committed = removeBlockingWorkflowToolRuns(
        { ...session, outputSchema: undefined },
        owningTurnId,
      );
      const cancelledSession = setHarnessEmissionState(
        {
          ...committed,
          history: validateHarnessModelMessages([...committed.history, ...cancelled.history]),
        },
        emissionState,
      );
      if (!input.reportUsage || getTurnUsageState(session.state) === undefined) {
        return { session: cancelledSession };
      }
      // Reported like a settled turn, as usage since the last report, so the
      // caller counts each turn once whether it settled or was cancelled.
      const reported = takeSessionUsageDelta(cancelledSession);
      return { result: reported.delta, session: reported.session };
    },
  });
  return usage === undefined ? published : { ...published, usage };
}
