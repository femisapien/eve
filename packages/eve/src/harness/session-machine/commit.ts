import { isSessionLimitPromptBatch } from "#harness/hitl/session-limit-input-requests.js";
import {
  getPendingInputBatches,
  removePendingInputBatches,
} from "#harness/pending-input-batches.js";
import {
  clearProxyInputRequestsWhere,
  getProxyInputRequests,
} from "#harness/proxy-input-requests.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";
import type { SessionProjection } from "#protocol/session-projection.js";
import type { SessionView } from "./transitions.js";

// The save side of a transition. A private record lives only while the projection shows its
// owner open, so closing an owner is one event: the transition reports it, the publish sink
// folds it, and the save drops the record here.

export function sessionView(
  projection: SessionProjection,
  state: SessionStateMap | undefined,
): SessionView {
  return { projection, relayedRequestIds: new Set(getProxyInputRequests(state).keys()) };
}

/** Drops the private records whose owner the projection shows closed. */
export function dropClosedRecords<T extends HarnessSession>(
  session: T,
  projection: SessionProjection,
): T {
  const isOpen = (requestId: string) => {
    const input = projection.inputs[requestId];
    return input !== undefined && input.status !== "settled";
  };
  let next = clearProxyInputRequestsWhere(session, (_route, requestId) => !isOpen(requestId));
  const closedPrompts = getPendingInputBatches(next.state).filter(
    (batch) =>
      isSessionLimitPromptBatch(batch) &&
      batch.requests.every((request) => !isOpen(request.requestId)),
  );
  if (closedPrompts.length > 0) next = removePendingInputBatches(next, closedPrompts) as T;
  return next;
}
