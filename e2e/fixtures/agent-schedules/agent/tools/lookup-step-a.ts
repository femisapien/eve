import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Smoke-test fixture: returns a deterministic stepKey that must be passed into the `lookup-step-b` tool to retrieve the final value. Only call when the user explicitly asks to use `lookup-step-a`.",
  inputSchema: z.object({
    topic: z.string().min(1).describe("Any non-empty topic string."),
  }),
  async execute() {
    throw new Error("lookup-step-a requires an eval tool stub.");
  },
});
