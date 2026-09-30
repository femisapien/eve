import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 27 sign-in events could omit `attemptId`, and action results had no
// `cancelled` status; both only add to what a reader receives.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: `Review evidence for session ${ctx.session.id}.` }),
  },
});
