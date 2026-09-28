import {
  defineWorkflowTool,
  type WorkflowToolContext,
  type WorkflowToolDefinition,
} from "eve/tools";
import { z } from "zod";

async function execute(_input: Record<string, never>, ctx: WorkflowToolContext): Promise<string> {
  "use workflow";
  const answer = await ctx.ask({
    prompt: "What is Alice's approval word?",
    allowFreeform: true,
    dismissible: false,
  });
  if (answer.status !== "answered") {
    throw new Error(`Remote question was not answered: ${answer.status}`);
  }
  return `REMOTE-QUESTION-ANSWER=${answer.text}`;
}

const tool: WorkflowToolDefinition<Record<string, never>, string> = defineWorkflowTool({
  description: "Ask the parent for a deterministic answer from a remote workflow tool.",
  inputSchema: z.object({}),
  execute,
});

export default tool;
