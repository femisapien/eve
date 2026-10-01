import { defineChannel, POST } from "#public/channels/index.js";

// Epoch 44 senders supplied separate question text without changing their deliver hook.
export default defineChannel({
  routes: [
    POST("/reply", async (_request, { from }) => {
      const session = await from("thread").send("Alice said: Saturday", {
        auth: null,
        answerText: "Saturday",
      });
      return Response.json({ sessionId: session.id });
    }),
  ],
  deliver(payload) {
    return { message: payload.message, context: payload.context };
  },
});
