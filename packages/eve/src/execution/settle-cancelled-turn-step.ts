import { deserializeContext, serializeContext } from "#context/serialize.js";
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
import { cancelTurn } from "#harness/session-lifecycle.js";
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
 * Settles one cancelled turn: settles the turn's calls as cancelled, emits
 * `turn.cancelled` → `session.waiting`, and persists the between-turns
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
  const emitted = await withSessionEventEmitter(
    {
      ctx,
      durableSession,
      origin: "own",
      sessionWritable: input.sessionWritable,
    },
    async (emit, scopedSession) => ({
      result: undefined,
      session: await cancelTurn(emit, scopedSession),
    }),
  );
  const cancelledSession = reconcileSessionContinuationToken(ctx, emitted.session);
  const base = { serializedContext: serializeContext(ctx) };
  if (!input.reportUsage || getTurnUsageState(cancelledSession.state) === undefined) {
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
