---
issue: TBD
status: draft
last_updated: "2026-09-29"
---

# Remote agents over MCP tasks

## Summary

eve calls a remote agent through its own protocol today. `defineRemoteAgent` starts a session on
the remote's `POST /eve/v1/session` and hands it a callback URL, and the remote reports back to
that URL. Separately, `mcpChannel` publishes an agent to MCP clients through four hand-rolled
tools, `agent_start`, `agent_get`, `agent_update`, and `agent_cancel`.

MCP now standardizes both halves. The tasks extension ([SEP-2663]) lets a `tools/call` return a
durable task that the client drives with `tasks/get`, `tasks/update`, and `tasks/cancel`. This
plan moves remote agents onto it:

1. **The server advertises its agent.** `mcpChannel` publishes the agent as a task-returning
   tool, alongside the tools and skills from the [MCP capabilities channel]. One channel serves
   all three.
2. **The client calls agents through MCP connections.** An agent behind an MCP connection is a
   subagent to the caller, and `defineRemoteAgent` is removed.
3. **Tasks replace callbacks.** The caller follows the task with `tasks/get` or
   `notifications/tasks`, so the remote no longer calls a URL that the caller supplied.

This plan depends on the capabilities channel, and does not change the parent-side task model
from [Tools as tasks](./tools-as-tasks.md): a remote subagent call still returns a task receipt to
the parent model. It changes only the wire between the two deployments.

## Today

| Surface                                | Wire                                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `defineRemoteAgent` (caller)           | `POST /eve/v1/session` with a framework callback URL; the callback settles the parent's task; `task_cancel` cancels on the remote. |
| `eveChannel` (remote)                  | serves that session API, accepts forwarded principals through `trustedForwarders`, and calls the callback.                         |
| `mcpChannel` (remote, for MCP clients) | `agent_start` returns an `invocationId`; `agent_get`, `agent_update`, and `agent_cancel` operate on it. No forwarded principals.   |

Both paths run the same durable execution: a task-mode session owned by the caller. What differs
is only how the caller starts it, answers its questions, and learns its result.

## Proposed authoring API

On the remote, the agent is published by the channel that already publishes its tools. Whether
it is advertised is the server's choice:

```ts title="agent/channels/mcp.ts"
import { vercelOidc, vercelSubject } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";

const router = vercelSubject({ teamSlug: "acme", projectName: "router" });

export default mcpChannel({
  auth: vercelOidc({ subjects: [router] }),
  trustedForwarders: (forwarder) => forwarder.subject === router,
  agent: true, // advertise the agent as a task-returning tool; default to be decided
});
```

On the caller, the remote is an ordinary MCP connection. Whether its agent is visible to the
model is the caller's choice:

```ts title="agent/connections/analytics.ts"
import { getVercelOidcToken } from "@vercel/oidc";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://analytics.example.com/eve/v1/mcp",
  description: "Analytics agent: product usage questions.",
  auth: { getToken: async () => ({ token: await getVercelOidcToken() }) },
  forwardPrincipal: true,
  agent: "subagent", // or "hidden": callable from ctx.agent(), not shown to the model
});
```

The two switches are independent, which is what the spec allows. A server may vary what it lists
by the caller's authorization, and a client decides what its model sees.

## Wire mapping

| Step              | Today (`defineRemoteAgent`)                                                           | Proposed (MCP tasks)                                                         |
| ----------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Start             | `POST /eve/v1/session` + callback                                                     | `tools/call` on the agent tool, declaring `io.modelcontextprotocol/tasks`    |
| Receipt           | session id                                                                            | `resultType: "task"` with a `taskId`                                         |
| Progress, result  | callback request to the caller                                                        | `tasks/get` polling, or `notifications/tasks` through `subscriptions/listen` |
| Questions         | not part of the documented contract                                                   | task `status: "input_required"`; answers through `tasks/update`              |
| Cancel            | `task_cancel`, forwarded to the remote                                                | `tasks/cancel`                                                               |
| Follow-up message | same `agentId`: cancel the running task, continue the remote session under a new task | `agentId` argument on the agent tool (a SEP-2567 handle), same semantics     |
| Routing           | session URL                                                                           | `Mcp-Name: <taskId>` on every task request                                   |

Two distinctions from the spec matter here:

- **Tasks are negotiated per request.** The client declares the extension on each call, and the
  server decides per call whether to return a task. A client that does not declare it gets an
  ordinary result, or an error for work that cannot finish inside one request.
- **Task questions are not MRTR.** Input the server needs before creating a task uses multi
  round-trip retries of `tools/call`. Input it needs during the task uses the task's own
  `inputRequests` and `tasks/update`. The two keep separate state.

## Invariants

1. Every task method checks that the caller owns the task: `tasks/get`, `tasks/update`, and
   `tasks/cancel` compare the request's principal with the task's owner, as `agent_*` does today.
2. No caller-supplied URL is ever fetched. Notifications ride the caller's own
   `subscriptions/listen` request, which removes the callback's SSRF surface.
3. One `agentId` runs one turn at a time. Reusing an `agentId` right after `tasks/cancel` must not
   start a second turn while the cancelled one is still stopping.
4. Clients bound their polling: they honor `pollIntervalMs`, back off, and give up after the
   task's `ttlMs`.
5. Forwarded principals follow the same `trustedForwarders` contract as the capabilities channel.

## Migration

1. `mcpChannel` gains the tasks extension and the agent tool. `agent_*` keeps working for
   clients that do not declare tasks until the removal step.
2. MCP connections gain the tasks extension, and connection agents become subagents in the
   parent's task model.
3. `defineRemoteAgent` and the `eveChannel` callback path are removed, and `agent_*` with them.
   Pre-1.0, this lands as a breaking change with a docs migration, not a compatibility layer.

## Validation

- Unit: the task state mapping, ownership checks on each task method, and `agentId` serialization
  across a cancel.
- Scenario: a real HTTP remote serving a task, with a question answered through `tasks/update`,
  a cancel, and notifications through `subscriptions/listen`.
- E2E: two fixture agents, one delegating to the other through an MCP connection, replacing the
  current remote-agent evals.
- Interop: an official-SDK MCP client that declares tasks drives the agent tool.

## Open questions

1. What does the agent tool look like: one tool named after the agent, or `agent` with the name
   in `server/discover`? What are its input schema and its `agentId` durability?
2. Does `agent: true` default on? What is the client default for `agent`?
3. What does the parent stream show for a connection agent, given that `session.streamSubagent()`
   reads the child's stream through the parent today? Tasks carry no progress notifications.
4. Do trace context and `outputSchema` carry over, and how are they declared on the wire?

[SEP-2663]: https://modelcontextprotocol.io/seps/2663-tasks-extension
[MCP capabilities channel]: ./mcp-capabilities-channel.md
