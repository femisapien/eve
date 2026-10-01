import { defineChannel, POST } from "eve/channels";

/** A formatted channel message must not become the answer to a pending question. */
export default defineChannel({
  state: { sender: "" },
  context(state) {
    return { state };
  },
  routes: [
    POST<{ sender: string }>("/attributed", async (request, { from }) => {
      const body = (await request.json()) as { address: string; text: string; answer?: boolean };
      const message = `Alice said:\n${body.text}`;
      const session = await from(body.address).send(message, {
        answerText: body.answer ? body.text : undefined,
        auth: {
          attributes: {},
          authenticator: "e2e-fixture",
          principalId: "alice",
          principalType: "user",
        },
        context: ["Alice is planning a release."],
        state: { sender: "alice" },
      });
      return Response.json({ sessionId: session.id });
    }),
  ],
});
