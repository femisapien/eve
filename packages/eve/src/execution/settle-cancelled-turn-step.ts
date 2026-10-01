import {
  commitCancelledCoordinationBatch,
  getPendingCoordinationBatch,
} from "#harness/coordination.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { retainAnswerableActivityBlockers } from "#execution/activity-cohort.js";
import {
  createDurableSessionState,
  type DurableSessionState,
  readDurableSession,
} from "#execution/durable-session-store.js";
import { withSessionEventEmitter } from "#execution/publish-session-events.js";
import { reconcileSessionContinuationToken } from "#execution/reconcile-session-continuation-token.js";
import {
  withSessionStateDelta,
  type WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { cancel } from "#harness/session-machine/transitions.js";
import { dropClosedRecords, sessionView } from "#harness/session-machine/commit.js";
import { currentProjection } from "#harness/session-machine/current.js";
import { removeBlockingWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { getTurnUsageState, takeSessionUsageDelta } from "#harness/turn-tag-state.js";
import type { TokenUsage } from "#shared/token-usage.js";

export interface CancelledTurnSettleResult {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  /** What the session spent since its caller's last report, when asked to report it. */
  readonly usage?: TokenUsage;
}

interface CancelledTurnSettleInput {
  /**
   * Whether a caller receives the turn's usage. Only then is it marked
   * reported; otherwise the next settled turn reports it.
   */
  readonly reportUsage: boolean;
  readonly sessionWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/**
 * Settles one cancelled turn: emits `turn.cancelled` → `session.waiting`,
 * drops pending coordination state, and persists the between-turns
 * session. Runs in the owner, whose wake sources exclude the
 * cancel hook, so a queued cancel wake cannot re-dispatch it.
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
  const durableSession = readDurableSession(input.sessionState);
  const ctx = await deserializeContext(input.serializedContext);
  // Before `turn.cancelled` projects, so only what stays answerable holds the work open.
  retainAnswerableActivityBlockers(ctx, durableSession.state);
  const cancelledTurnId = currentProjection(ctx).activeTurnId;
  const emitted = await withSessionEventEmitter(
    { ctx, durableSession, origin: "own", sessionWritable: input.sessionWritable },
    async (emit, scopedSession) => {
      for (const event of cancel(sessionView(currentProjection(ctx), scopedSession.state))) {
        await emit(event);
      }
      return { result: undefined, session: scopedSession };
    },
  );
  const session = emitted.session;

  // The cancel reported every request and call it closed; what remains is execution the turn
  // no longer runs: its parked calls commit to history as cancelled, and its runs are forgotten.
  const owningTurnId =
    getPendingCoordinationBatch(session.state)?.event.turnId ?? cancelledTurnId ?? "";
  const cancelledSession = reconcileSessionContinuationToken(
    ctx,
    dropClosedRecords(
      commitCancelledCoordinationBatch(
        removeBlockingWorkflowToolRuns({ ...session, outputSchema: undefined }, owningTurnId),
      ),
      currentProjection(ctx),
    ),
  );
  const base = { serializedContext: serializeContext(ctx) };
  if (!input.reportUsage || getTurnUsageState(session.state) === undefined) {
    return { ...base, sessionState: createDurableSessionState({ session: cancelledSession }) };
  }
  // Reported like a settled turn, as usage since the last report, so the
  // caller counts each turn once whether it settled or was cancelled.
  const reported = takeSessionUsageDelta(cancelledSession);
  return {
    ...base,
    sessionState: createDurableSessionState({ session: reported.session }),
    usage: reported.delta,
  };
}
