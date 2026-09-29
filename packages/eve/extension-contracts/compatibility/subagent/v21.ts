import { defineAgent, defineDynamic } from "#public/index.js";

export default defineAgent({
  description: "Help Alice summarize her notes.",
  model: defineDynamic({
    events: {
      "turn.started": () => "openai/gpt-5.4",
    },
  }),
  defaultTools: false,
});
