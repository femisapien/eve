---
issue: TBD
status: draft
last_updated: "2026-09-28"
---

# Agents over MCP

## Summary

eve agents talk to each other over two bespoke protocols today. Remote agents use eve's session
routes with a push callback. External harnesses use `mcpChannel`, whose four `agent_*` tools
hand-roll a task lifecycle. Neither lets a caller use a specialist's tools directly, and neither is
something a non-eve client or server already speaks.

Proposal: make MCP `2026-07-28`, with the official tasks extension (`io.modelcontextprotocol/tasks`),
the one protocol between agents.

- **Provider side.** One MCP channel publishes an agent's tools, its skills as resources, and
  itself and its subagents as callable agents. An agent is a tool that the server marks as an
  agent and that answers with a task. The server decides what it advertises; nothing about it is
  configured on the caller.
- **Caller side.** One MCP connection per provider gives access to everything the provider
  advertises: tools, skills, and agents. `defineRemoteAgent` is removed, along with its session
  callback protocol. A remote agent is an agent tool found on a connection.
- **Core and userland.** Core gains two primitives: introspect and invoke a tool outside a model
  turn. The MCP mapping is built on top, as an eve channel or in userland.

Evidence from a prototype on branch `rui/vmcp`. An orchestrator agent called the tools of three
specialist agents directly and replayed 24 cases from the specialists' own eval suites twice. It
matched remote subagents on pass rate (94% each). Median latency halved (15 s against 28 s), and
tokens per run fell to about a quarter (25k against 92k).

## Goals

- One wire protocol for agent-to-agent calls, standard enough that non-eve clients and servers
  interoperate.
- Callers choose per capability: call a tool, read a skill, or delegate a task.
- Every interrupt, meaning approval, sign-in, or a question, reaches a human through eve's
  existing input UI and is answered by that human, never by a model.
- No authority in client-held state.
- A lean core: MCP specifics live outside `execution/` and `harness/`.

Non-goals: replacing `eveChannel` for frontends and the client SDK; changing local subagents.

## Layering

| Layer              | Owns                                                                                                      | Where                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Core primitives    | list tools, skills, and subagents; invoke a tool outside a turn with auth, sandbox, approval, and sign-in | `eve` core, new public route-context API |
| MCP server adapter | MCP methods, tasks, `input_required`, sealed request state, skill URIs                                    | `eve/channels/mcp`                       |
| MCP client         | discovery, calls, agent tools, task polling, interrupts mapped to `ctx.ask`                               | eve MCP client connection                |
| Policy             | which tools to expose, who may forward whom                                                               | the agent author                         |

A user-defined route today receives only session handles, `waitUntil`, and path params
(`RouteHandlerArgs`). It cannot list the agent's tools, run one with `ctx`, evaluate its approval
policy, or open its sandbox, so an MCP server cannot be built in userland. The prototype's
`execution/capability-session.ts`, about 720 lines, is the missing primitive. The other roughly
1,200 lines are MCP mapping that could live above it.

The client side is already userland in the prototype (the orchestrator's `discover`,
`load_skill`, and `tool_call` tools). It moves into eve so that every eve agent gets it.

## Authoring API

### Provider

```ts title="agent/channels/mcp.ts"
import { vercelOidc, vercelSubject } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";

const router = vercelSubject({ teamSlug: "acme", projectName: "router" });

export default mcpChannel({
  auth: vercelOidc({ subjects: [router] }),
  trustedForwarders: (forwarder, assertion) =>
    forwarder.subject === router && isRouterUser(assertion.principal?.current),
  expose: { tools: true, skills: true, agents: true }, // default
});
```

`expose` narrows what the channel publishes; per-tool filtering is an open question. This
replaces both the current `mcpChannel` (`agent_*` tools) and the prototype's
`mcpCapabilitiesChannel`. Pre-1.0, the four `agent_*` tools are removed rather than kept alongside
tasks.

### How a server advertises an agent

The agent itself and each exposed subagent become one tool, advertised in `tools/list`:

```json
{
  "name": "analytics",
  "description": "Answers questions about product usage data.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "message": { "type": "string" },
      "agentId": { "type": "string", "description": "Continue an earlier conversation." },
      "outputSchema": { "type": "object" }
    },
    "required": ["message"]
  },
  "_meta": { "dev.eve/kind": "agent" }
}
```

- The description is the agent's own description, so the provider controls how callers see it.
- `server/discover` advertises `io.modelcontextprotocol/tasks`. A call answers with a task,
  durably created before the response.
- The completed task's result carries the answer and an `agentId` handle for follow-ups.
- `dev.eve/kind: "agent"` is a hint. A caller that ignores it still gets a correct tool that
  returns a task, so a non-eve MCP client can delegate to an eve agent without knowing it is one.

### Caller: one connection

```ts title="agent/connections/analytics.ts"
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://analytics.example.com/eve/v1/mcp",
  auth: vercelOidc(),
  forwardPrincipal: true,
});
```

What the connection surfaces depends on what the server advertises:

| Advertised                        | Caller behavior                                                                                                                                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool                              | Found with `connection_search` and called directly, as connection tools are today.                                                                                                                   |
| Skill (`skill://` resource)       | Loaded with `load_skill`; the connection's skills join the local ones in the model's skill index.                                                                                                    |
| Agent (`dev.eve/kind: "agent"`)   | A delegation tool that is always visible, like a local subagent. The call runs as a background task, emits the same `subagent.called` and `subagent.completed` events, and continues with `agentId`. |
| Any tool that answers with a task | A background task on the caller, polled until it settles.                                                                                                                                            |

### Exposure on both ends

MCP leaves this decision to each end. What a server lists "MAY vary by the authorization presented
on the request". How a client presents tools is its own choice: tools are model-controlled, but
"implementations are free to expose tools through any interface pattern", and resources are
application-driven. MCP has no notion of an agent, and no per-tool task flag. `dev.eve/kind` is a
custom `_meta` hint that other clients ignore.

eve uses both ends:

- **The server decides what exists.** `expose` publishes or withholds tools, skills, and agents,
  optionally per caller. A server that does not want to be delegated to omits its agent tool, and
  no client can call it as an agent.
- **The client decides what its model sees.** Each advertised capability gets one of three modes:
  `always` (in the model's tool list every step, like a local subagent), `search` (found through
  `connection_search`), or `code` (callable only from authored code through `ctx.agent`, like a
  subagent's `tool: false` today). The existing `tools: { allow | block }` filter still decides
  what is usable at all, and it applies to agent tools too.

```ts title="agent/connections/analytics.ts"
export default defineMcpClientConnection({
  url: "https://analytics.example.com/eve/v1/mcp",
  auth: vercelOidc(),
  forwardPrincipal: true,
  tools: { block: ["manage_dynamic_schedules"] }, // existing filter
  load: { agents: "code", tools: "always" }, // defaults: agents "always", tools "search"
});
```

`load.tools: "always"` is the per-connection form of the preloading asked for in #3745. A
connection that needs sign-in before listing falls back to `search`, so loading never fails a step.

Dynamic targets, runtime URLs, and per-session availability come from dynamic connections
(`defineDynamic` in `eve/connections`), which replace the same features of `defineRemoteAgent`.
This builds on the open client gaps in #2727 (`_meta`, client capabilities, resources) and #2432
(request count per call).

## Protocol mapping

What each `defineRemoteAgent` behavior becomes on an MCP connection. _Standard_ is MCP 2026-07-28
or the tasks extension. _eve_ is an eve-specific extension under a `dev.eve/` prefix. Nothing
in the left column survives as its own API.

| `defineRemoteAgent` today                     | On an MCP connection                                                                              | Status                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `POST /eve/v1/session` starts a durable child | `tools/call` on the agent tool returns a task (`resultType: "task"`, durable before the response) | standard                                  |
| `{ status: "working", taskId, agentId }`      | `CreateTaskResult` with `taskId`; `agentId` in the result as a SEP-2567 handle                    | standard                                  |
| Callback settles the task                     | poll `tasks/get` at `pollIntervalMs`; optional push, see Delivery                                 | standard poll, eve push                   |
| Child asks a question or needs sign-in        | task `input_required` with `inputRequests`; answer with `tasks/update`                            | standard                                  |
| Follow-up message to the same child           | `tools/call` with `agentId` as an argument                                                        | standard (handle pattern)                 |
| Steer a running child                         | `tasks/cancel`, then a new call with `agentId`                                                    | standard; SEP-2669 `tasks/steer` proposed |
| `task_cancel`                                 | `tasks/cancel`                                                                                    | standard                                  |
| Reset children when the parent ends           | task and handle TTLs, plus an explicit close                                                      | eve (`dev.eve/close`), see open questions |
| `forwardPrincipal`                            | `eve-forwarded-principal` header, checked by `trustedForwarders`                                  | eve (no token passthrough)                |
| Trace linkage, lineage, content ceiling       | `traceparent`, `tracestate`, `baggage` in `_meta` (reserved by MCP)                               | standard keys, eve semantics              |
| `session.streamSubagent()` relay              | `statusMessage` on `tasks/get`; richer streams wait for event sources                             | gap                                       |
| `outputSchema` on `ctx.agent`                 | an `outputSchema` argument on the agent tool                                                      | eve convention                            |
| `url`, `auth`, `headers`, runtime URLs        | the connection's `url`, `auth`, and `headers`                                                     | existing connection API                   |
| `defineDynamic` remote agents                 | dynamic connections                                                                               | existing connection API                   |
| `description`                                 | the agent tool's description, written by the provider                                             | standard                                  |
| `tool: false` with `ctx.agent(name)`          | `ctx.agent("<connection>/<agent>")`; hiding the tool from the model is a connection filter        | eve convention, see open questions        |

## Interrupts

There are three moments at which a call can need a person, and each has a standard carrier.

```text
before work starts      tools/call → input_required (MRTR) → retry with inputResponses
during a task           tasks/get → input_required → tasks/update → working
on the caller           each inputRequest → ctx.ask() in a workflow step → human answer
```

- **Before work starts.** The tool's approval policy runs before execution. The server returns MRTR
  `input_required` with a form, and the client retries the same call with the answer.
- **During a task.** A running agent that asks a question or needs a credential moves its task to
  `input_required`. The client answers with `tasks/update`, and the task returns to `working`.
- **On the caller.** The client never passes an input request to its model. The call runs as a
  workflow. Each approval, question, or sign-in becomes a `ctx.ask()`, rendered by the caller's
  channel as it renders its own approvals. The human's answer becomes the `inputResponse`. Sign-in
  links go to the user privately, and the confirmation is a `ctx.ask()` too.

Rules:

1. **Request state carries no authority.** It correlates a retry with its call and nothing more.
   Every retry evaluates the approval policy again, and requires the approval answer when the
   policy requires approval. The prototype's `p` flag let a client skip approval by editing
   unsigned state; MCP requires integrity protection for any state that affects authorization.
   If a server needs trusted continuation state, it seals it with a deployment secret and an
   expiry.
2. **The client echoes request state untouched,** and keeps it out of model context, as MCP
   requires.
3. **The user who starts a sign-in completes it.** The callback binds to the principal that raised
   the challenge, or the channel supports only provider-owned grants such as Connect, which survive
   retries without eve holding callbacks.
4. **Pending sign-ins are durable.** Attempts and callbacks do not live in process memory.
5. **A missing answer asks again** instead of counting as a decline.

## Delivery

MCP delivers task completion by polling today; the Triggers and Events working group owns push
callbacks, and its "Task Event Sources" draft is experimental. The eve client therefore:

- polls `tasks/get` from a durable workflow loop, sleeping `pollIntervalMs` between reads without
  holding compute;
- offers a push hint when both sides are eve: the caller sends a callback URL in
  `_meta["dev.eve/callback"]`, and the server posts a task notification there. The client still
  confirms the result with `tasks/get`, so the push carries no authority;
- replaces the push hint with the standard mechanism once Triggers and Events lands.

## Sessions, handles, and sandboxes

The prototype scopes a session with a client-chosen header, `eve-capability-session`. The session
id hashes the forwarder, the forwarded user, and the key, and it names the sandbox, so reuse works
across instances without stored state. SEP-2567 recommends server-minted handles carried as tool
arguments instead. For agent tasks the handle is natural: `agentId`. For tool calls, a handle
would need a tool such as `open_session` and an extra argument on every tool. See the open
questions.

## Migration

1. Core primitives: introspection and invocation, behind an internal API first.
2. `mcpChannel` serves tools, skills, and tasks on top of them. The prototype's security defects
   are fixed before anything else ships.
3. The MCP client connection gains skills, agent tools, forwarding, and interrupt handling through
   `ctx.ask`.
4. Callers replace each `agent/subagents/<name>.ts` that calls `defineRemoteAgent` with an
   `agent/connections/<name>.ts`. Receivers serve both `eveChannel` sessions and `mcpChannel` for
   one release, so mixed fleets keep working during deploys.
5. `defineRemoteAgent` and the session-route callback protocol for remote agents are removed.

## Validation

- Unit: listing filters, session derivation, request-state tamper rejection, forwarder refusal,
  task state transitions.
- Scenario: a real HTTP server for discover and prewarm, approval, sign-in across two instances,
  a task with a mid-run question, cancellation, and steering.
- E2E: two fixture agents joined by one MCP connection. The caller delegates to the provider's
  agent tool, including a follow-up with `agentId` and a mid-task question, and calls one of its
  tools directly, including an approval answered through `ctx.ask`.
- Interop: a non-eve MCP client (an official SDK with tasks) drives an eve agent; an eve agent
  drives a non-eve tasks server.

## Open questions

1. One `mcpChannel` with `expose`, or separate channels for capabilities and agents?
2. Server-minted session handles, or the `eve-capability-session` header, for tool calls?
3. How are children closed when the parent ends: TTLs only, or an eve `dev.eve/close` call?
4. How does a caller stream a child's events before MCP event sources exist?
5. Should approval be answerable only by the forwarded user, and how does `ctx.ask` enforce who
   answers in a shared thread?
6. Should connections enable the tasks extension automatically, so any MCP server's long tool calls
   become eve background tasks?
7. Is `load` the right shape, or should visibility live on `connection_search` as #3745 proposes?
   Per-tool modes (for example one agent `always`, another `code`) may be needed.
8. How does an authored workflow address a connection agent: `ctx.agent("<connection>/<agent>")`,
   or a separate call for connection tools?
9. Should a provider's subagents be advertised by default, or only the root agent?

## References

- MCP 2026-07-28: [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
  [multi round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr),
  [elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation).
- [SEP-2663, tasks extension](https://modelcontextprotocol.io/seps/2663-tasks-extension) (Final).
- [SEP-2567, sessionless MCP](https://modelcontextprotocol.io/seps/2567-sessionless-mcp).
- [Triggers and Events working group](https://modelcontextprotocol.io/community/working-groups/triggers-events)
  and its [Task Event Sources draft](https://github.com/modelcontextprotocol/experimental-ext-triggers-events/pull/2).
- [SEP-2640, skills over MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md).
- eve: `docs/guides/remote-agents.md`, `docs/channels/mcp.mdx`, `docs/tools/workflows.mdx`
  (`ctx.ask`), issues #2727, #2432, #3631.
