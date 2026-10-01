---
"eve": minor
---

`mcpChannel` now publishes the agent's invocable tools and skills over MCP. `tools/list` returns the tools with their JSON schemas, and `tools/call` runs one in a tool session. A tool that needs approval or a sign-in returns an MCP `input_required` result with a signed `requestState`. Set `EVE_MCP_REQUEST_STATE_SECRET` (at least 32 bytes, the same value on every instance) in production. Without it, those tools return an error, and tools that need neither keep working. Clients that declare the `dev.eve/tool-sessions` extension in their capabilities and send `_meta["dev.eve/tool-session"]` get a tool session, and its sandbox, that lasts across calls. Otherwise every call runs in a one-off session.

Skills are served under the SEP-2640 skills extension as `skill://<skill>/<path>` resources through `skills/list`, `skills/get`, `resources/list`, `resources/read`, and `resources/directory/read`. Each file is capped at 512 KiB, and files over it are left out. A skill is not served at all when its name or description is not valid Agent Skills frontmatter, its `SKILL.md` is missing or unreadable, or it exceeds 512 files or 16 MiB.

The new options are `tools` and `skills` (both default `true`; `false` turns the surface off), `trustedForwarders` to accept an `eve-forwarded-principal` header from a trusted router, and `requestStateSecret`.
