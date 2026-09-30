import { defineDynamic, defineTool } from "#public/tools/index.js";

// Epoch 63 sign-in events could omit `attemptId`, and action results had no
// `cancelled` status; both only add to what a reader receives.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineTool({
        description: "Return the active session identifier.",
        inputSchema: { type: "object", properties: {} },
        execute: (_input, toolCtx) => ({ callId: toolCtx.callId, sessionId: ctx.session.id }),
      }),
  },
});
