import { clearPendingAuthorization } from "#harness/authorization.js";
import {
  consumeDeferredStepInput,
  getPendingInputBatches,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import type { HarnessSession } from "#harness/types.js";

// Execution state the session machine keeps beside the projection: what it needs to resume work,
// never whether that work is open. These operations discard execution after a transition
// reported its close.

const APPROVAL_STATE_KEY = "eve.runtime.hitl.approvalState";

/**
 * Discards the execution a cleared context owned: its parked approval steps and the
 * session-limit prompt, queued input, sign-in attempts, and responders' approval progress.
 * `clear` reported each close; requests relayed for live tasks keep their routes.
 */
export function discardContextWork(session: HarnessSession): HarnessSession {
  let next = removePendingInputBatches(session, getPendingInputBatches(session.state));
  next = consumeDeferredStepInput({ session: next }).session;
  const { [APPROVAL_STATE_KEY]: _approvals, ...state } =
    clearPendingAuthorization(next.state) ?? {};
  return { ...next, state: Object.keys(state).length > 0 ? state : undefined };
}
