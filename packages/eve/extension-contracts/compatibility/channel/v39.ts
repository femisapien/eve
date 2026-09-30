import { defineChannel, GET } from "#public/channels/index.js";

// Epoch 39 route handlers had no `describe` or `readSkill` args; epoch 40 adds both.
export default defineChannel({
  routes: [
    GET("/status/:sessionId", async (_request, { attachSession, params, requestIp }) => {
      await attachSession(params.sessionId!).cancel();
      return Response.json({ requestIp });
    }),
  ],
});
