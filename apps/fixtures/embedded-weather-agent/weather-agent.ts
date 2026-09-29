import { createAgent } from "eve";
import { defineSkill } from "eve/skills";
import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export default createAgent({
  model: "openai/gpt-5.6-luna-fast",
  modelOptions: {
    providerOptions: {
      openai: {
        reasoningEffort: "high",
        reasoningSummary: "auto",
      },
    },
  },
  instructions:
    "You are a weather-focused assistant. Be concise, accurate, and explicit about when you are using the local weather tool.",
  tools: {
    get_weather: defineTool({
      approval: never(),
      description: "Get the current weather for a city.",
      inputSchema: z.object({
        city: z.string(),
      }),
      async execute(input) {
        const city = input.city;

        await sleep(300);

        return {
          city,
          temperatureF: 72,
          condition: "Sunny",
          summary: `Sunny in ${city} with a light breeze.`,
        };
      },
    }),
  },
  skills: {
    "get-weather": defineSkill({
      description: "Use the weather tool before answering forecast or temperature questions.",
      markdown:
        "When the user asks about weather, temperature, or forecast conditions, call the `get_weather` tool before answering.",
    }),
  },
});
