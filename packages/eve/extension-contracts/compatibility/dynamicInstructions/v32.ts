import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

// Epoch 32 tool-call action requests could carry `parentCallId` for nested
// actions; epoch 33 drops it, since connection tools no longer report them.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      defineInstructions({
        markdown: `Triage the incident reported in session ${ctx.session.id}.`,
      }),
  },
});
