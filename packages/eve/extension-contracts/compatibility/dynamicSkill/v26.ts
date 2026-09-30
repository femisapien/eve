import { defineDynamic, defineSkill } from "#public/skills/index.js";

// Epoch 26 sign-in events could omit `attemptId`, and action results had no
// `cancelled` status; both only add to what a reader receives.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineSkill({
        description: `Review evidence for session ${ctx.session.id}.`,
        markdown: "# Evidence review\n\nCheck every claim against its source.",
      }),
  },
});
