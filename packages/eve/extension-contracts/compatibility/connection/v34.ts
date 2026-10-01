import { defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 34 MCP connections had no `forwardPrincipal`; epoch 35 adds it as optional.
// Connections that omit it send no forwarded-principal header, as before.
export default defineMcpClientConnection({
  description: "Search the support knowledge base.",
  url: "https://support.example.com/mcp",
  approval({ toolName }) {
    return toolName.endsWith("__search") ? "approved" : "user-approval";
  },
});
