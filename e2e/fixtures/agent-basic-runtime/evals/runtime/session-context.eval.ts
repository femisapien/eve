import { defineEval, type EveEvalTurn } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description:
    "Session context and per-turn client context reach tools and the stream, including prewarmed sessions.",
  async test(t) {
    const sessionContext = { surface: "docs", preferences: { compact: true } };
    const firstContext = { page: "/docs/redirects" };
    const message = "Alice opened the docs chat. Read its session context.";
    for (const prewarm of [false, true]) {
      let first: EveEvalTurn;
      if (prewarm) {
        first = await (
          await t.session({ sessionContext })
        ).send(message, { clientContext: firstContext });
      } else {
        const created = await t.target.fetch("/eve/v1/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionContext, message, clientContext: firstContext }),
        });
        await t.require(created.status, equals(202));
        const { sessionId } = (await created.json()) as { sessionId: string };
        first = await t.target.watchTurn(sessionId).result();
      }
      const sessionId = first.sessionId;
      first.expectOk();
      first.event("session.started", { count: 1 });
      first.event("message.received", { data: { clientContext: firstContext } });
      first.calledTool("read_session_context");
      first.messageIncludes(JSON.stringify({ session: sessionContext, turn: firstContext }));

      const replacement = await t.target.fetch(`/eve/v1/session/${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: "Alice continues the chat.",
          sessionContext: { surface: "support" },
        }),
      });
      await t.require(replacement.status, equals(400));

      const second = await first.session.send(
        "Alice selected a few lines in the same chat. Read its session context again.",
        { clientContext: ["route: /docs/redirects", "selection: lines 4-9"] },
      );
      second.expectOk();
      second.event("message.received", {
        data: { clientContext: ["route: /docs/redirects", "selection: lines 4-9"] },
      });
      second.calledTool("read_session_context");
      second.messageIncludes(
        JSON.stringify({
          session: sessionContext,
          turn: ["route: /docs/redirects", "selection: lines 4-9"],
        }),
      );

      const third = await second.session.send(
        "Alice is continuing the chat without a page selection. Read its session context again.",
      );
      third.expectOk();
      third.calledTool("read_session_context");
      third.messageIncludes(JSON.stringify({ session: sessionContext }));

      const fourth = await third.session.send(
        "Alice is checking the same chat with a text note. Read its session context again.",
        { clientContext: "Alice is reading the docs." },
      );
      fourth.expectOk();
      fourth.event("message.received", {
        data: { clientContext: "Alice is reading the docs." },
      });
      fourth.calledTool("read_session_context");
      fourth.messageIncludes(
        JSON.stringify({ session: sessionContext, turn: "Alice is reading the docs." }),
      );
    }
  },
});
