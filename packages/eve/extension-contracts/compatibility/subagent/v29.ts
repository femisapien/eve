import { defineAgent } from "#public/index.js";

// Epoch 29 `tool` accepted only a boolean; epoch 30 also accepts `"deferred"`.
export default defineAgent({
  description: "Research the incidents behind a metric change.",
  model: "openai/gpt-5.6-sol",
  tool: false,
});
