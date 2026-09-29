---
issue: TBD
status: draft
last_updated: "2026-09-29"
---

# MCP capabilities channel

## Summary

An agent that routes work to specialist eve agents today can only hand them whole tasks. The
specialist runs its own model loop, and the router's model reads its prose. The gap is on the
server side. eve's MCP connections already send `tools/call` to any MCP server, but an eve agent
publishes none of its tools: `mcpChannel` offers only the `agent_*` task tools. A prototype on branch
`rui/vmcp` let an orchestrator call three specialists' tools directly instead. Replaying 24 cases
from the specialists' own eval suites twice, it matched remote subagents on pass rate (94% each),
halved median latency (15 s against 28 s), and used about a quarter of the tokens (25k against 92k).

This plan covers the first phase of that work:

1. **Core**: additions to surfaces eve already has, on `eve/client` and in route handlers.
   `describe()` returns what the agent offers callers: its tools and skills, without deployment
   details.
   `sessions.create({ capabilities: true })` creates a session that runs tools instead of turns.
   `session.invokeTool` runs one tool with the context it gets in a turn, inside the request and
   without parking. `session.readSkill` reads one skill file.
2. **Server**: `mcpCapabilitiesChannel`, a stateless MCP `2026-07-28` server that only adapts MCP
   onto those operations.
3. **Client**: MCP connections that can consume it, including interrupts answered by a person.

Once it lands, any MCP client can call an eve agent's tools with a plain `tools/call`, the MCP
Inspector included. Two follow-up plans build on it, and phase 1 does not depend on either:

- [Remote agents over MCP tasks](./remote-agents-over-mcp-tasks.md): agents advertised as
  task-returning tools, a unified `mcpChannel`, and the removal of `defineRemoteAgent`.
- [Client-side capability discovery](./mcp-client-discovery.md): how a calling model finds
  and calls remote tools and skills. It starts in userland, as the prototype's did.

Phase 1 does not change `mcpChannel`, `eveChannel`, or remote agents.

## How `mcpChannel` works today

`mcpChannel` publishes an agent at `/eve/v1/mcp` for MCP clients such as Claude Code. It serves
`tools/call`, but only for four tools of its own:

| Tool                                       | Does                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `agent_start { message }`                  | starts one durable agent task and returns an `invocationId`                                  |
| `agent_get { invocationId }`               | reads its state: `working`, `input_required`, `authorization_required`, or a terminal status |
| `agent_update { invocationId, responses }` | answers the pending questions                                                                |
| `agent_cancel { invocationId }`            | requests cooperative cancellation                                                            |

```text
tools/call agent_start { message }
  routeAuth(request)                       → principal P, on every request
  WorkflowAgentInvocationExecution.create  → a durable task-mode session owned by P
    the agent runs a whole turn: its model loop, its tools, its sandbox
  ← { invocationId, status: "working", pollAfterMs }
tools/call agent_get / agent_update        → read the run's state / deliver answers to its inbox
```

Three properties matter here:

- **The only execution path is starting a session.** Every task runs the agent's model loop. The
  agent's own tools never appear in `tools/list`, so a client cannot call one directly, only ask
  the agent in a message and hope its model calls it.
- **Tasks are hand-rolled.** The four tools recreate what the MCP tasks extension now standardizes
  (`tools/call` returning a task, then `tasks/get`, `tasks/update`, and `tasks/cancel`). Moving to
  it changes the wire format, not the execution, and belongs to phase 2.
- **Identity is the direct caller.** The channel has no `trustedForwarders`; work runs as the
  authenticated principal.

Agent invocation therefore already exists. What is missing is running one tool.

## Core framework changes

### Why core has to change

A tool's `execute` expects a context that only the harness builds today: the caller in
`ctx.session.auth`, the session's sandbox through `ctx.getSandbox()`, and credentials through
`ctx.getToken()`. Before `execute`, the harness evaluates the
tool's approval policy.

A channel route has none of this. `RouteHandlerArgs` offers session handles (`from`,
`attachSession`, `to`), `waitUntil`, and path params. A route cannot list the agent's tools, run
one with its real context, evaluate its approval policy, or open its sandbox. So an MCP server
for an agent's tools cannot be written in userland without reimplementing each tool outside eve.

Two alternatives were considered and rejected:

- **Start a session per call** and ask the agent to run the tool. That puts a model call back in
  front of every tool call, which is the cost this work removes, and makes execution
  nondeterministic.
- **Keep the logic inside the channel**, as the prototype does. The prototype needs private access
  to context keys, the approval runtime, tool auth, harness authorization signals, the sandbox
  runtime, and the compiled tool registry. That couples a channel to core internals, and no other
  channel or extension could reuse it.

Almost everything the channel needs exists already, on the client (`eve/client`) or inside the
framework. The changes extend those surfaces instead of adding a separate one:

| Need                     | Remote, `eve/client`                                 | In a route handler                                   |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------------------- |
| An agent's tools, skills | only inside `client.info()`, with deployment details | internal only (`readAgentInfoRouteResponse`)         |
| Create an idle session   | `client.sessions.create()`                           | internal only; `attachSession(id)` for existing ones |
| Session operations       | `ClientSession`: `send`, `stream`, `cancel`, …       | `Session`: `send`, `respond`, `cancel`, …            |
| Run one tool             | missing                                              | missing                                              |
| Read one skill file      | missing                                              | missing                                              |

The harness loop does not change. The work adds a tool execution scope that comes from a request
instead of a turn.

### 1. `describe()`: what the agent offers callers

`GET /eve/v1/info` is an inspection payload, the same view `eve info` prints for the local
application. Alongside the agent's name, description, tools, and skills, it carries `appRoot` and
`agentRoot`, source paths, config, composition and discovery diagnostics, hooks, kernel effects,
sandbox, mode, channels, memories, schedules, and connections. Its consumers need that:

| Consumer                                      | Reads                                          |
| --------------------------------------------- | ---------------------------------------------- |
| `mcpChannel`                                  | the agent's name and description               |
| eval targets                                  | the agent's name; `mode` and dev-route support |
| dev TUI, dev-client probe, remote-agent setup | the whole inspection payload                   |

None of those details may reach an MCP caller, so the caller-facing view is a new, separate
surface. `info()` and `/eve/v1/info` stay as they are:

- **`describe()` returns `AgentDescription`**, on `Client` and on route args. This is what the
  channel publishes.
- **`info()` stays the inspection surface**, with its current auth, which is Vercel OIDC outside
  development. Nothing that reads it moves.

```ts
interface AgentDescription {
  readonly name: string;
  readonly description?: string;
  readonly tools: readonly {
    name: string;
    description: string;
    inputSchema: JsonObject;
    outputSchema?: JsonObject;
    approval: boolean; // the tool declares an approval policy
    invocable: boolean; // invokeTool can run it outside a turn
  }[];
  readonly skills: readonly { name: string; description: string; files: readonly string[] }[];
}
```

- Tools are not invocable when they depend on a turn: framework tools (`bash`, `load_skill`),
  workflow tools, background tools, and tools with special handling. They suspend, run past the
  request, or change the harness itself. The channel lists only invocable tools.
- The order is deterministic, so callers can cache the list.
- Subagents are not listed in phase 1.

### 2. Capability sessions: `sessions.create({ capabilities: true })`

Route args gain `sessions.create()`, the same operation clients already have as
`client.sessions.create()`. With `capabilities: true`, it creates a capability session. A
capability session exists for identity and the sandbox. It is a real eve session, created
without a message through the existing prewarm path, but it has no turns, no steps, and no
authored state.

It holds:

- **An owner**: the principal that created it (`auth.current`, `auth.initiator`, and the
  forwarder, if any). Every call checks it.
- **A sandbox**, named after the session and started on create. A conversation prewarm parks
  before sandbox setup, and its first turn does the rest. A capability session never runs a turn,
  so create does the setup the first tool call would otherwise wait for. The sandbox idle timeout
  bounds a session that is never used.
- **The tools, skills, and connections its owner resolves.** `session.started` resolvers run
  once, at create, and their results hold for the session's lifetime.
- **Framework-owned sign-in state**, such as a pending sign-in (open question 1).
- **A server-issued id**, as SEP-2567 recommends, instead of a key the client chooses.

It has none of these, and the channel documentation must say so:

- **No turns and no steps.** No call is wrapped in a turn or a step. `turn.started` and
  `step.started` never fire, so a tool or connection defined only on those events does not exist
  in a capability session, and `ctx.session.turn` is absent.
- **No authored session state.** `defineState` belongs to conversations, where step boundaries
  give its updates a commit point. A capability session has no such point: `get()` returns the
  declared initial value, and `update()` throws an error that names the tool. State that must
  outlive a call lives in the sandbox, or behind a handle the tool returns, the pattern SEP-2567
  recommends.
- **No ordering between calls.** Calls may run in parallel, as MCP `tools/call` requests and a
  model's parallel tool calls already can. Nothing serializes them.
- **No model, instructions, history, or messages.** Its handle is its own type, without `send`,
  `respond`, or `stream`.

`capabilities: true` is a placeholder name.

### 3. Session operations: `invokeTool` and `readSkill`

Both are added to the route `Session` and to `ClientSession`. The client form uses a new eve
HTTP route, so an eve caller can run another eve agent's tools without MCP.

```ts
interface Session {
  // ...existing operations
  invokeTool(name: string, input: unknown, options?: InvokeToolOptions): Promise<InvokeToolResult>;
  readSkill(skill: string, path?: string): Promise<string | Uint8Array>; // default: SKILL.md
  describe(): Promise<AgentDescription>; // includes what session.started resolved for the owner
}

interface InvokeToolOptions {
  auth?: SessionAuthContext; // route handlers: the caller this request authenticated
  callId?: string; // correlates the retries of one call
  approval?: { approved: boolean }; // the person's answer, when the caller has one
  signal?: AbortSignal;
}

type InvokeToolResult =
  | { status: "completed"; output: unknown; modelOutput: ToolModelOutput }
  | { status: "failed"; message: string; errorId: string }
  | { status: "invalid-input"; message: string }
  | { status: "denied"; reason?: string }
  | { status: "approval-required"; callId: string }
  | {
      status: "authorization-required";
      callId: string;
      challenges: readonly AuthorizationChallenge[];
    };
```

Every call checks that the caller owns the session, which is the rule `mcpChannel` already
applies to invocations. The tool then sees the same `ctx` it sees in a turn:

- `ctx.session.id` is the capability session. `ctx.session.auth.current` is the caller, and
  `.initiator` is the session's creator.
- `ctx.getSandbox()` opens the session's sandbox.
- `ctx.getToken()` resolves the user's grant, and returns `authorization-required` when a sign-in
  is needed.
- `ctx.session.turn` and `ctx.session.parent` are absent, because there is no turn. `turn`
  becomes optional in `SessionContext`, and its absence is how a tool knows it was called
  directly.
- Session state reads return initial values, and writes throw (section 2).

**Tools run inside the request and never park.** Parking exists so that a turn can wait for a
person. MCP's multi round-trip requests already move that wait to the client: the call ends with
`input_required`, and the client retries with the answer. A stateless function can serve each
retry. So no call state outlives a request, and no workflow step wraps a call. A tool that needs
longer than one request is an agent task, which belongs to phase 2.

**Approval is evaluated on every call, and nothing carries over between calls.**

1. The request policy runs.
2. If it requires approval and `approval` is absent, the result is `approval-required`.
3. If `approval` is present, the response policy runs with the caller as the responder.
4. Only then does the tool run.

A retry after sign-in passes `approval` again. There is no "already approved" input. `callId`
only correlates retries, for example for approval policies that pin the requester by call id. A
forged `callId` can make a response policy refuse, but it cannot grant anything. The prototype
carried an "approved" flag in client-held state, and a client could set it to skip approval.
This contract removes that possibility at the primitive, instead of relying on each channel.

**Sign-in stores the grant, not the call.** When `getToken` needs a sign-in, the result is
`authorization-required` with its challenges. The provider's callback lands on eve's existing
connection callback route. The route has no parked run to resume, so it completes the exchange
itself, and the retry runs the tool from the start.

- **The grant must outlive the request.** Today the callback resumes a parked run, and eve keeps
  the minted token only in a per-step cache. A strategy that stores grants, such as Vercel
  Connect, works unchanged. Other interactive strategies need a place for the grant.
- **So must the attempt's start state**, such as a PKCE verifier. Today the parked run holds it.
- **The person completing a sign-in must be the one who started it.** MCP requires this for
  URL-mode elicitation. The prototype did not check it.
- **Retries rerun the tool from the start.** Tools should resolve credentials before side effects.

## Server: `mcpCapabilitiesChannel`

```ts title="agent/channels/mcp-capabilities.ts"
import { vercelOidc, vercelSubject } from "eve/channels/auth";
import { mcpCapabilitiesChannel } from "eve/channels/mcp";

const router = vercelSubject({ teamSlug: "acme", projectName: "router" });

export default mcpCapabilitiesChannel({
  auth: vercelOidc({ subjects: [router] }),
  // Check both identities: on session creation the asserted initiator becomes auth.initiator.
  trustedForwarders: (forwarder, assertion) =>
    forwarder.subject === router &&
    assertion.principal !== undefined &&
    isRouterUser(assertion.principal.current) &&
    isRouterUser(assertion.principal.initiator),
});
```

| Option              | Meaning                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `auth`              | Required. The same policies as other channels, including `oauthResource(...)`.                                  |
| `route`             | Defaults to `/eve/v1/mcp-capabilities`.                                                                         |
| `trustedForwarders` | The same predicate and `ForwardedAssertion` contract as `eveChannel`. Absent: forwarded principals are refused. |

The channel is an adapter. Each MCP method maps onto one of the operations above:

| MCP                                                                          | eve                                                |
| ---------------------------------------------------------------------------- | -------------------------------------------------- |
| `server/discover`                                                            | `describe()`                                       |
| a new capability session, requested by the client                            | `sessions.create({ capabilities: true })`          |
| `tools/list`                                                                 | `describe().tools`, invocable only                 |
| `skills/list`, `skills/get` (SEP-2640)                                       | `describe().skills`                                |
| `resources/read` for `skill://<skill>/SKILL.md` and `skill://<skill>/<file>` | `session.readSkill`                                |
| `resources/directory/read` for `skill://<skill>`                             | `describe().skills[].files`                        |
| `tools/call`                                                                 | `session.invokeTool`                               |
| `approval-required`                                                          | MRTR `input_required` with a boolean approval form |
| `authorization-required`                                                     | MRTR `input_required` with URL elicitations        |

The MCP rules the channel must follow:

- Every request authenticates again. Principals come from route auth plus
  `eve-forwarded-principal`, checked by `trustedForwarders`. Calls name their session with the
  server-issued id, and the session operations check ownership.
- **`requestState` carries only `callId` and a binding** to the session, tool, and argument hash.
  It is never evidence that a check passed; the operation re-evaluates everything. A retry whose
  binding does not match is rejected. The state has an expiry.
- A retry that is missing a requested answer gets `input_required` again, not a decline.
- `_meta` keys use the reverse-DNS prefix `dev.eve/`, such as `dev.eve/owner` and
  `dev.eve/approval`.
- Elicitations are only sent in the modes the client declared. List results carry `ttlMs` and
  `cacheScope`, and responses are JSON only. The official SDK already enforces these.
- Skills follow SEP-2640. The channel declares `io.modelcontextprotocol/skills`, and the last
  segment of a skill path is the skill's `name`. The server already scopes the URI, so it carries
  no agent prefix.

### Calling it from any MCP client

The channel is a plain MCP `2026-07-28` server, so nothing on the calling side has to be eve. Under
`eve dev` with `auth: localDev()`, the MCP Inspector CLI can list and call an agent's tools and
read its skills:

```sh
URL="http://localhost:2000/eve/v1/mcp-capabilities" # the URL `eve dev` prints
mcp() { npx @modelcontextprotocol/inspector --cli --transport http --server-url "$URL" "$@"; }

mcp --method tools/list
mcp --method tools/call --tool-name query_usage \
  --tool-args-json '{"account":"acme","window":"30d"}'
mcp --method skills/list
mcp --method resources/read --uri skill://usage-triage/SKILL.md
```

- `tools/list` returns the invocable tools with their input and output schemas.
- `tools/call` runs the tool as the authenticated caller and returns `structuredContent`. A
  failing tool returns `isError: true`, and the Inspector exits `5`.
- A call that names no capability session runs in a one-off session. Its sandbox does not outlive
  the call (see open question 2).
- Tools that need approval or a sign-in answer with `input_required`. They run only for a client
  that answers it; a client that cannot gets the request and nothing executes.
- A deployed agent needs a channel `auth` the client can satisfy: a bearer token through
  `--header "Authorization: Bearer ..."`, or `oauthResource(...)` for clients that run the MCP
  sign-in flow, such as the Inspector's web UI.

This is also the channel's interop test.

## Client: eve connections

### Today

eve's MCP connections wrap `@ai-sdk/mcp` (`runtime/connections/mcp-client.ts`). The client already
speaks 2026-07-28: it calls `server/discover`, sends `Mcp-Method`, and falls back to the
`initialize` handshake for older servers (`protocolVersionDiscovery`). It does not support multi
round-trip requests: an `input_required` result fails the call with "multi round-trip requests are
not supported yet". It also has no tasks support, and eve's connections do not read resources or
keep tool `_meta` (#2727). So a plain `tools/call` works today, and a connection could list and
call the channel's tools once it exists, but any
approval or sign-in fails. The prototype's client was userland because of these gaps: three
tools in the orchestrator that call MCP directly.

### Changes

1. **Multi round-trip support in the client**, wrapped behind the existing connection API: return
   `input_required` with its `inputRequests` and `requestState` instead of failing, and retry with
   `inputResponses`. This lands upstream in `@ai-sdk/mcp` or in an eve-owned wrapper.
2. **The caller's harness waits for its person (core).** The provider never parks, but the
   caller has to wait for its own user's answer. A connection tool call that returns
   `input_required` parks the way connection authorization already does. The harness emits `input.requested`,
   which the channel renders as it renders its own approvals, and on the answer retries the call
   with `inputResponses`. `requestState` stays in the tool call's durable state, never in model
   history. A person answers, not the model. This must be core: only the harness can park an
   ordinary tool call and resume it. The userland alternative, a workflow tool that calls
   `ctx.ask()`, works for one bespoke tool but not for connection tools in general.
3. **Forwarding and session scope.** `defineMcpClientConnection({ forwardPrincipal: true })` sends
   `eve-forwarded-principal`, with the same semantics as remote agents. The connection requests
   one capability session per caller session and keeps its id with the caller session, so one
   conversation keeps one provider sandbox.

```ts title="agent/connections/analytics.ts"
import { getVercelOidcToken } from "@vercel/oidc";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://analytics.example.com/eve/v1/mcp-capabilities",
  description: "Analytics agent: product usage tools and skills.",
  auth: { getToken: async () => ({ token: await getVercelOidcToken() }) },
  forwardPrincipal: true, // proposed in this plan
});
```

A provider behind Vercel Deployment Protection also needs the calling project allowed as a
Trusted Source; the header that carries the OIDC token for that check is part of the forwarding
work above.

How the calling model finds and calls those tools and skills is out of scope here. Plain
connection tools keep working through `connection_search`. Remote skills, a combined catalog,
and the choice between materialized connection tools and one dispatch tool belong to
[Client-side capability discovery](./mcp-client-discovery.md). They can be built in userland on
top of this phase, as the prototype's `discover`, `load_skill`, and `tool_call` tools were.

## Security invariants

1. Every request authenticates, and forwarded identity is accepted only through
   `trustedForwarders`.
2. Client-held state never grants authority. Approval is re-evaluated on every call.
3. No call state outlives a request. The person who starts a sign-in completes it, and the grant
   is stored rather than the call.
4. The client answers interrupts with a person's input, and keeps `requestState` out of the model.
5. Capability sessions and their sandboxes belong to the principals that created them, and every
   call checks ownership.
6. MCP callers see only `AgentDescription`. The inspection payload from `info()` never reaches
   them.
7. Work is bounded: request body 1 MiB, forwarded header 16 KiB, session id 512 characters, skill
   file 512 KiB.

## Follow-up plans

- [Remote agents over MCP tasks](./remote-agents-over-mcp-tasks.md): agents as task-returning
  tools, one `mcpChannel` for tools, skills, and agents, and `defineRemoteAgent` removed.
- [Client-side capability discovery](./mcp-client-discovery.md): search, visibility, remote
  skills, and connection calls from authored tools.
- Tabled: whether authors choose which tools the channel exposes, beyond the invocable filter.

## Validation

- Unit: `describe()` (no inspection fields, invocable filter, order), approval
  re-evaluation (a forged `callId` or missing answer never executes), request-state binding and
  expiry, session ownership, forwarder refusal.
- Unit: capability session semantics. `session.started` resolves once at create,
  `turn.started` and `step.started` never fire, state reads return initial values and writes
  throw, and two calls in one session run in parallel.
- Scenario: a real HTTP server covering discover, capability session creation with a warm
  sandbox, a plain call, approval, and sign-in with the callback on a different instance from the
  retry.
- E2E: two fixture agents. One calls the other's tools through an MCP connection, including an
  approval answered through `input.requested` and a skill read.
- Interop: the MCP Inspector CLI lists, calls, and reads skills against a fixture, as in
  [Calling it from any MCP client](#calling-it-from-any-mcp-client).

## Open questions

1. Where do grants and sign-in start state live for interactive strategies that do not store
   their own, now that no parked run holds them? Is Vercel Connect the only supported strategy
   in phase 1?
2. How does an MCP client request a capability session and learn its id? MCP defines no session
   API. SEP-2567 makes handles a tool pattern: a `create_*` tool returns an opaque id that later
   calls pass, and the server checks `(handle, auth_context)` on every call. It also forbids list
   results that vary per connection, so session creation cannot ride on `server/discover`. One
   option is an `open_session` tool, with eve connections sending the id in
   `_meta["dev.eve/session"]` so it stays out of the model.
3. What should `capabilities: true` be called?
4. Every call reads the session's owner. Is one world read per `tools/call` acceptable, or is the
   owner cached for the session's lifetime?
5. What route serves `describe()` for `Client`, for example `GET /eve/v1/describe`, and with which
   auth?
6. SEP-2567 lets `tools/list` vary by the caller's authorization but not by session. Dynamic tools
   resolve on `session.started`. Does the channel resolve them per principal for `tools/list`,
   and what session does a resolver see there?

## References

- MCP 2026-07-28: [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
  [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
  [multi round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr),
  [elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation).
- [SEP-2567, sessionless MCP](https://modelcontextprotocol.io/seps/2567-sessionless-mcp);
  [SEP-2640, skills over MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md);
  [SEP-2663, tasks](https://modelcontextprotocol.io/seps/2663-tasks-extension).
- [MCP Inspector CLI](https://github.com/modelcontextprotocol/inspector/blob/main/clients/cli/README.md).
- eve: `docs/tools/human-in-the-loop.md`, `docs/tools/workflows.mdx` (`ctx.ask`),
  `docs/connections/mcp.mdx`; issues #2727, #2432, #3745.
