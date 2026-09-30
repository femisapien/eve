import { defineAgent, defineDynamic } from "#public/index.js";

// Epoch 24 sign-in events could omit `attemptId`, and action results had no
// `cancelled` status; both only add to what a reader receives.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      ctx.session.auth.current === null
        ? null
        : defineAgent({
            description: "Investigate the authenticated user request.",
            model: "openai/gpt-5.6-sol",
          }),
  },
});
