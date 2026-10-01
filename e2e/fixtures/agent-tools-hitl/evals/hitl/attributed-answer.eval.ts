import { defineEval, type EveEvalTargetHandle } from "eve/evals";

async function send(target: EveEvalTargetHandle, address: string, text: string, answer = false) {
  const response = await target.fetch("/attributed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, text, answer }),
  });
  if (!response.ok) throw new Error(`Attributed message failed: ${response.status}`);
  return (await response.json()) as { sessionId: string };
}

export default defineEval({
  description:
    "Channel-formatted replies answer questions without injecting their envelope or context.",
  timeoutMs: 120_000,
  async test(t) {
    for (const text of ["Production", "Canary pool in us-east"]) {
      const address = crypto.randomUUID();
      const started = await send(
        t.target,
        address,
        'Alice is planning a release. Call the ask_question tool exactly once with question "Where should Alice ship first?" and exactly two options labeled "Staging" and "Production". Wait for my answer before you continue.',
      );
      const waiting = await t.target.watchTurn(started.sessionId).result();
      waiting.session.requireInputRequest({ toolName: "ask_question" });
      const resumed = t.target.watchTurn(started.sessionId, { startIndex: waiting.events.length });
      await send(t.target, address, text, true);
      const answered = await resumed.result();
      answered.expectOk();
      answered.calledTool("ask_question", {
        output: { answer: text, status: "answered" },
        status: "completed",
      });
    }
    t.noFailedActions();
  },
});
