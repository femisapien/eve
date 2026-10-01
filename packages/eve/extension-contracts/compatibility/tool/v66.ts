import { defineTool } from "#public/tools/index.js";

// Epoch 66 connections had no `forwardPrincipal`; epoch 67 adds it as optional
// on MCP connections. Tools that read action requests keep the same fields.
export default defineTool({
  description: "Look up an order by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  approval: ({ toolName, toolInput }) =>
    toolName === "lookup_order" && typeof toolInput?.id === "string"
      ? "not-applicable"
      : "user-approval",
  execute: (input) => ({ id: (input as { readonly id: string }).id }),
});
