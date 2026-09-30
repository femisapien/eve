import { z } from "zod";
import { defineTool } from "#public/tools/index.js";

// Epoch 65 sign-in events could omit `attemptId`, and action results had no
// `cancelled` status. Compiled epoch 65 tools still park on sign-in through
// ctx.getToken; both changes only add to what a reader receives.
export default defineTool({
  description: "List the caller's open tickets.",
  inputSchema: z.object({ project: z.string() }),
  async execute({ project }, ctx) {
    const { token } = await ctx.getToken({
      principalType: "user",
      async getToken() {
        return { token: "ticket-token" };
      },
    });
    return { authorized: token.length > 0, project };
  },
});
