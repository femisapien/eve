import { defineTool } from "eve/tools";
import { z } from "zod";
import { DYNAMIC_PACKAGE_NAME, DYNAMIC_PACKAGE_REFERENCE } from "../lib/dynamic-skill-package";

export default defineTool({
  description: "Read the dynamic package release checklist through its skill handle.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    return await ctx.getSkill(DYNAMIC_PACKAGE_NAME).file(DYNAMIC_PACKAGE_REFERENCE).text();
  },
});
