---
issue: TBD
status: draft
last_updated: "2026-09-29"
---

# Client-side capability discovery

## Summary

Once the [MCP capabilities channel] lands, an eve agent can reach many remote tools and skills
through MCP connections. This plan decides how its model finds and calls them. It is a separate
decision from the channel: the server side is the same for every pattern here, and the patterns
can be built and measured in userland before any of them becomes framework API.

The prototype on branch `rui/vmcp` built one pattern in userland: `discover`, `load_skill`, and
`tool_call`. eve's `connection_search` is another. Nothing yet compares them on the same cases.

## The two existing patterns

**`connection_search` (eve today).** The model searches with keywords across every connection,
or one. For each target, eve fetches the connection's tool metadata when the model searches, then
scores matches. Matches become real tools, callable on the next step as `<connection>__<tool>`.
Sign-in can happen during search. Skills are not searched.

**`discover` (prototype, userland).** At `session.started`, the orchestrator sends
`server/discover`, `tools/list`, and `resources/list` to every provider in parallel, and caches
the results per session and provider for 30 minutes. The fan-out is also what warms each
provider's sandbox. `discover(query, kind?, owner?, limit?)` searches that local index, with no
network call, and returns owner-tagged tools with their `inputSchema`, plus skills. The model then
calls `tool_call(owner, tool, args)` or `load_skill(owner, name, path?)`. Remote tools never
become model tools.

| Axis                 | Materialized tools (`connection_search`)                                       | Dispatch (`discover` + `tool_call`)                          |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Argument validation  | the model API enforces each tool's schema                                      | arguments are data; errors return as `invalid-input` retries |
| Approvals and labels | eve's per-tool handling applies                                                | rendered per call by the dispatcher                          |
| Prompt cache         | the tool list grows mid-session, which typically invalidates the cached prefix | the tool list is fixed                                       |
| Catalog fetch        | at search time                                                                 | once per session, before the first model call                |
| Skills               | not included                                                                   | searched with tools                                          |

Two more axes cross both patterns: whether some tools are always visible instead of behind search
(#3745), and code mode, where the model writes a program that calls tools.

## Evidence so far

The prototype measured only the dispatch pattern. On 24 cases from the specialists' eval suites,
run twice against live previews, dispatch matched remote subagents on pass rate (94% each) with a
15 s median latency against 28 s, and 25k tokens against 92k. Warehouse-backed cases were
excluded because previews cannot reach the query gateway. The materialized pattern was not run
on remote capabilities.

## What userland needs from the framework

The prototype brought its own MCP client, because an authored tool cannot call a connection
today. A userland pattern built on eve's connections needs one public surface for that:

```ts
// Inside an authored tool or dynamic resolver (proposed)
const analytics = ctx.connection("analytics");
const tools = await analytics.listTools();
const result = await analytics.callTool("query_usage", input);
const skill = await analytics.readResource("skill://usage-triage/SKILL.md");
```

It would reuse the connection's auth, principal forwarding, tool session, and
`input_required` handling from the capabilities channel's client work, so userland patterns get
the same guarantees as framework ones. This is the only framework change this plan proposes
before a pattern is chosen.

## Remote skills

Skills served over MCP follow [SEP-2640]: `skills/list` and `skills/get` enumerate them, and
their files are `skill://` resources. Whatever pattern wins, hosts must key a remote skill by the
pair of connection and URI, because two servers can serve the same `skill://refunds/SKILL.md`.
The open choice is how the model reaches them: through `load_skill` with a connection argument,
through the discovery tool, or through a virtual mount that turns file reads into
`resources/read`.

## Validation plan

1. Build the materialized pattern and the dispatch pattern on the proposed connection surface.
2. Run both on the same 24 cases, with the same models and the same live providers. Report pass
   rate, latency, input and cached tokens, and prompt-cache hit rate.
3. Repeat at a larger catalog, since the prompt-cache difference grows with the number of
   discovered tools.
4. Promote the winner, or both behind a connection option, to framework API only after that.

## Open questions

1. Is `ctx.connection(name)` the right shape, and is it available to dynamic resolvers as well as
   tools?
2. Should the session-start fan-out stay userland, or become a connection option, given that it
   also prewarms the providers' sandboxes?
3. How do remote skills appear in the skill index without loading every server's list up front?
4. How does this compose with #3745's always-loaded tools and with code mode?

[MCP capabilities channel]: ./mcp-capabilities-channel.md
[SEP-2640]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md
