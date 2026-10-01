---
"eve": minor
---

`mcpChannel` now publishes the agent's invocable tools over MCP. `tools/list` returns them with their JSON schemas, and `tools/call` runs one in a tool session. A tool that needs approval or a sign-in returns an MCP `input_required` result with a signed `requestState`. Set `EVE_MCP_REQUEST_STATE_SECRET` (at least 32 bytes, the same value on every instance) in production. Without it, those tools return an error, and tools that need neither keep working. The new options are `tools` and `skills` (both default `true`, and the skills feature plugs in through the same server), `trustedForwarders` to accept an `eve-forwarded-principal` header from a trusted router, and `requestStateSecret`. Clients that send `_meta["dev.eve/tool-session"]` get a tool session, and its sandbox, that lasts across calls.
