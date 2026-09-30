import { defineHook } from "#public/hooks/index.js";

// Epoch 32 sign-in events could omit `attemptId`, and action results had no
// `cancelled` status; both only add to what a reader receives.
export default defineHook({
  events: {
    "authorization.required"(event, ctx) {
      console.info("sign-in required", {
        attemptId: event.data.attemptId,
        name: event.data.name,
        sessionId: ctx.session.id,
      });
    },
    "authorization.completed"(event) {
      console.info("sign-in completed", { name: event.data.name, outcome: event.data.outcome });
    },
  },
});
