import { defineChannel, POST } from "#public/channels/index.js";

// Epoch 43 channels send plain messages without the optional answerText field.
export default defineChannel({
  routes: [
    POST("/messages", async (_request, { from }) => {
      const session = await from("thread").send("Saturday", {
        auth: null,
        context: ["Alice replied"],
      });
      return Response.json({ sessionId: session.id });
    }),
  ],
  deliver(payload) {
    return { message: payload.message, context: payload.context };
  },
});
