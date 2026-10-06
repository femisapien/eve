import type { SessionAuthContext } from "#channel/types.js";
import { runAsCaller } from "#context/caller-scope.js";
import { contextStorage } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { HumanInput } from "#harness/hitl/index.js";
import type { InputRequest } from "#shared/input.js";
import type { SessionStateMap } from "#harness/types.js";

/**
 * The person who approved each call the current step replays, by call id.
 * Step-local: set before the replay, never serialized.
 */
const ApprovedCallCallersKey = new ContextKey<ReadonlyMap<string, SessionAuthContext>>(
  "eve.approvedCallCallers",
);

/**
 * Records who approved each call in `requests`, so each approved call runs as
 * its approver while the rest of the turn keeps the turn's own caller.
 */
export function setApprovedRequests(
  requests: readonly InputRequest[],
  state: SessionStateMap | undefined,
): void {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) return;
  const callers = new Map<string, SessionAuthContext>();
  const humanInput = HumanInput.read(state);
  for (const request of requests) {
    const approver = humanInput.approverOfRequest(request.requestId);
    if (approver !== undefined) callers.set(request.action.callId, approver);
  }
  ctx.setVirtualContext(ApprovedCallCallersKey, callers);
}

/** Runs `fn` as the call's approver when `callId` is an approved call; otherwise as is. */
export function runAsApprover<T>(callId: string | undefined, fn: () => T): T {
  const approver =
    callId === undefined
      ? undefined
      : contextStorage.getStore()?.get(ApprovedCallCallersKey)?.get(callId);
  return approver === undefined ? fn() : runAsCaller(approver, fn);
}

/** A streaming call's body runs on each `next()`, so each one runs as the approver too. */
export async function* iterateAsApprover<T>(
  callId: string | undefined,
  iterable: AsyncIterable<T>,
): AsyncIterable<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await runAsApprover(callId, () => iterator.next());
      if (result.done === true) return;
      yield result.value;
    }
  } finally {
    await iterator.return?.();
  }
}
