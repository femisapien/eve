import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Smoke-test fixture: returns the final value for a stepKey previously obtained from `lookup-step-a`. Only call when the user explicitly asks to use `lookup-step-b`.",
  inputSchema: z.object({
    stepKey: z
      .string()
      .min(1)
      .describe("The exact `stepKey` returned by a prior call to `lookup-step-a`."),
  }),
  async execute() {
    throw new Error("lookup-step-b requires an eval tool stub.");
  },
});
