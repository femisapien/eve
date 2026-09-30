---
"eve": minor
---

**Breaking:** `mcpChannel` no longer serves the `agent_start`, `agent_get`, `agent_update`, and `agent_cancel` tools, or the durable invocation sessions behind them. The channel keeps its route, auth, OAuth protected-resource metadata, HTTP security checks, and body limits, and currently publishes no tools; publishing the agent's own tools and skills comes next. MCP clients that started agent tasks through `agent_*` stop working; eve callers should use `defineRemoteAgent` over `eveChannel` instead.
