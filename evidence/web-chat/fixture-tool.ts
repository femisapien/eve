import { defineTool } from "eve/tools";
import { z } from "zod";
export default defineTool({
  description: "Return deterministic UI fixture data.",
  inputSchema: z.object({ command: z.string(), format: z.string() }),
  execute: () => ({ status: "ready", sessions: 4, output: "sandbox-ok" }),
});
