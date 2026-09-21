import type { RouteHandlerArgs } from "eve/channels";
import type { SessionStore } from "./session-store.ts";

/** A parent grants read access only to children recorded in its durable stream. */
export async function canReadSubagent(
  request: Request,
  args: RouteHandlerArgs,
  owner: string,
  store: SessionStore,
): Promise<boolean> {
  const url = new URL(request.url);
  const parent = url.searchParams.get("parentSessionId");
  const call = url.searchParams.get("callId");
  const child = args.params.sessionId;
  if (!parent || !call || !child || parent === child || !(await store.owns(owner, parent)))
    return false;
  const session = args.attachSession(parent);
  const tail = await session.getStreamTailIndex();
  if (tail < 0) return false;
  const reader = (await session.getEventStream({ startIndex: 0 })).getReader();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (let index = 0; index <= tail && !signal.aborted; index++) {
      const { value, done } = await reader.read();
      if (done) break;
      if (
        value.type === "subagent.called" &&
        value.data.sessionId === parent &&
        value.data.callId === call &&
        value.data.childSessionId === child &&
        !value.data.remote
      )
        return true;
    }
    return false;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
