import type { SubagentCalledStreamEvent, MessageStreamEvent } from "eve/client";

export type SubagentSession = SubagentCalledStreamEvent["data"];
export function subagentKey(session: SubagentSession) {
  return JSON.stringify([session.sessionId, session.remote?.url ?? null, session.childSessionId]);
}
export function subagentStreamPath(session: SubagentSession, startIndex = 0) {
  const parent = encodeURIComponent(session.sessionId);
  const child = encodeURIComponent(session.childSessionId);
  const call = encodeURIComponent(session.callId);
  // Derive same-origin framework routes; never fetch an event's remote URL in the browser.
  const path = session.remote
    ? `/eve/v1/session/${parent}/subagents/${call}/${child}/stream`
    : `/eve/v1/session/${child}/stream`;
  const query = new URLSearchParams({ startIndex: String(startIndex), includeTailIndex: "1" });
  if (!session.remote) {
    query.set("parentSessionId", session.sessionId);
    query.set("callId", session.callId);
  }
  return `${path}?${query}`;
}

/** NDJSON records may span network chunks, including UTF-8 characters. */
export async function* readSubagentEvents(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<MessageStreamEvent> {
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Sign in again to view this subagent."
        : response.status === 404
          ? "This subagent session is no longer available."
          : "Unable to load this subagent session.",
    );
  if (!response.body) throw new Error("The subagent stream is empty.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      if (done && pending.trim()) {
        lines.push(pending);
        pending = "";
      }
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.$eve) continue;
        if (typeof event.type !== "string" || !event.meta)
          throw new Error("Invalid subagent stream.");
        yield event as MessageStreamEvent;
      }
      if (done) return;
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
