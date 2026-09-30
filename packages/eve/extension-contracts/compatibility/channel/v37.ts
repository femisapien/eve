import { defineChannel } from "#public/channels/index.js";

// Epoch 37 sign-in events could omit `attemptId`, and action results had no
// `cancelled` status; both only add to what a reader receives.
export default defineChannel({
  routes: [],
  events: {
    "authorization.required"(event) {
      console.info("sign-in required", { name: event.name, url: event.authorization?.url });
    },
    "authorization.completed"(event) {
      console.info("sign-in completed", { name: event.name, outcome: event.outcome });
    },
  },
});
