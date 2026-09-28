import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";

/**
 * Asks for a release sign-off that only the person who requested the release
 * may give. Another participant's answer is ignored, so the question stays
 * pending until the requester answers.
 */
export default defineWorkflowTool({
  description: "Release a service after the person who asked for it signs off.",
  inputSchema: z.strictObject({ service: z.string() }),
  async execute({ service }, ctx) {
    "use workflow";

    const answer = await ctx.ask(
      {
        display: "confirmation",
        options: [
          { id: "approve", label: "Release", style: "primary" },
          { id: "cancel", label: "Cancel" },
        ],
        prompt: `Release ${service}?`,
      },
      { answerableBy: "requester" },
    );
    return { released: answer.status === "answered" && answer.optionId === "approve", service };
  },
});
