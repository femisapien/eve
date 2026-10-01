---
"eve": patch
---

`mcpChannel` can now publish the agent's invocable tools and skills next to the `agent_*` tools. Both are off by default, so an existing channel serves exactly what it did before. Set `tools: true` to list tools with their JSON schemas and run each `tools/call` in a tool session, and `skills: true` to serve skills under `skill://`. A tool that needs approval or a sign-in returns an MCP `input_required` result with a signed `requestState`. Set `EVE_MCP_REQUEST_STATE_SECRET` (at least 32 bytes, the same on every instance) in production. Without it, those tools return an error, and tools that need neither keep working. `trustedForwarders` accepts an `eve-forwarded-principal` header from a trusted router, and `requestStateSecret` sets the secret in code. Clients that send `_meta["dev.eve/tool-session"]` keep one tool session, and its sandbox, across calls.
