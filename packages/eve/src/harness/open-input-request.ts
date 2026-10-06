import { getApprovalAuditState } from "#harness/approval-candidates.js";
import { getPendingInputBatches, type PendingInputBatch } from "#harness/pending-input-batches.js";
import { getProxyInputRequests, type ProxyInputRequest } from "#harness/proxy-input-requests.js";
import type { SessionStateMap } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

/** An unanswered request, and whether the session's own turn or a relay holds it. */
export type OpenInputRequest =
  | {
      readonly batch: PendingInputBatch;
      readonly kind: "parked";
      readonly request: InputRequest;
    }
  | {
      readonly kind: "relayed";
      readonly requestId: string;
      readonly route: ProxyInputRequest;
    };

/**
 * The request a typed reply answers: the first open request nobody has
 * answered yet, in the order the session asked. A budget prompt comes first,
 * since the session settles it before anything else. Channels that can only
 * show text show requests one at a time in this order, so a reply answers the
 * request the person sees.
 */
export function firstOpenInputRequest(
  state: SessionStateMap | undefined,
  answered: (requestId: string) => boolean = () => false,
): OpenInputRequest | undefined {
  // An approval answered on its own settles before the rest of its batch.
  const settled = new Set(
    getApprovalAuditState(state).settlements.map((settlement) => settlement.requestId),
  );
  const isOpen = (requestId: string) => !settled.has(requestId) && !answered(requestId);
  const batches = getPendingInputBatches(state).filter(
    (batch) => batch.awaitsCoordination !== true,
  );
  const isLimit = (batch: PendingInputBatch) =>
    batch.requests.some((request) => request.kind === "session-limit");
  // A turn asks for its own approvals before the calls it waits on relay theirs.
  for (const batch of [...batches.filter(isLimit), ...batches.filter((b) => !isLimit(b))]) {
    const request = batch.requests.find((candidate) => isOpen(candidate.requestId));
    if (request !== undefined) return { batch, kind: "parked", request };
  }
  for (const [requestId, route] of getProxyInputRequests(state)) {
    if (isOpen(requestId)) return { kind: "relayed", requestId, route };
  }
  return undefined;
}
