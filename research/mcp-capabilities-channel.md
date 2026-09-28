---
issue: TBD
status: draft
last_updated: "2026-09-28"
---

# MCP capabilities channel

## Summary

An agent that routes work to specialist agents today can only hand them whole tasks. The
specialist runs its own model loop, and the router's model reads its prose. A prototype on branch
`rui/vmcp` let an orchestrator call three specialists' tools directly instead. Replaying 24 cases
from the specialists' own eval suites twice, it matched remote subagents on pass rate (94% each),
halved median latency (15 s against 28 s), and used about a quarter of the tokens (25k against 92k).

This plan covers the first phase of that work:

1. **Core**: two public primitives. `introspect` lists an agent's tools and skills. `invokeTool`
   runs one tool outside a model turn, with the same context the tool gets inside one. Pending
   sign-ins also become durable.
2. **Server**: `mcpCapabilitiesChannel`, a stateless MCP `2026-07-28` server built only on those
   primitives.
3. **Client**: MCP connections that can consume it, including interrupts answered by a person.

Agent calls come later, in a second phase with its own plan: agents advertised as task-returning
tools, a unified `mcpChannel`, and the removal of `defineRemoteAgent`. Phase 1 does not change
`mcpChannel`, `eveChannel`, or remote agents.

## Core framework changes

### Why core has to change

A tool's `execute` expects a context that only the harness builds today: the caller in
`ctx.session.auth`, the session's sandbox through `ctx.getSandbox()`, credentials through
`ctx.getToken()`, and skills through `ctx.getSkill()`. Before `execute`, the harness evaluates the
tool's approval policy. When `getToken` needs a sign-in, the harness parks the call and resumes it
later.

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

The primitives below give every channel and extension the same path into tool execution. The
harness loop does not change. The work adds an execution scope that comes from a request instead
of a workflow run.

### 1. Introspection

Route handlers receive the agent they serve:

```ts
interface RouteAgent {
  readonly name: string;
  readonly description: string;
  introspect(): AgentIntrospection;
  invokeTool(name: string, input: unknown, options: InvokeToolOptions): Promise<InvokeToolResult>;
  prepareSession(options: InvokeSessionOptions): void; // start the session's sandbox in the background
}

interface AgentIntrospection {
  readonly tools: readonly {
    name: string;
    description: string;
    inputSchema: JsonObject;
    outputSchema?: JsonObject;
    approval: boolean; // the tool declares an approval policy
  }[];
  readonly skills: readonly { name: string; description: string; files: readonly string[] }[];
  readSkillFile(
    skill: string,
    path: string | undefined,
    options: InvokeSessionOptions,
  ): Promise<string | Uint8Array>;
}
```

- Listed tools are the agent's authored and extension tools. Framework tools (`bash`,
  `load_skill`), workflow tools, background tools, and tools with special handling are excluded,
  because they depend on a turn: they suspend, run past the request, or change the harness itself.
- The order is deterministic, so callers can cache the list.
- Subagents are not listed in phase 1.

### 2. `invokeTool`

```ts
interface InvokeSessionOptions {
  auth: {
    current: SessionAuthContext | null;
    initiator?: SessionAuthContext | null;
    forwarder?: SessionAuthContext;
  };
  key?: string; // the caller's conversation key
}

interface InvokeToolOptions extends InvokeSessionOptions {
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

The tool sees the same `ctx` it sees in a turn:

- `ctx.session.auth.current` and `.initiator` come from `auth`.
- `ctx.session.id` is derived by core from the caller identities and the key:
  `sha256(forwarder, current, key)`. Two callers, or two users behind one forwarder, never share a
  session by choosing the same key. Without a key, the session is one-off, and its sandbox is
  deleted after the call.
- `ctx.getSandbox()` opens the sandbox named after the session, so any instance reaches the same
  sandbox without stored state.
- `ctx.getToken()` resolves the user's grant, and returns `authorization-required` when a sign-in
  is needed.

**Approval is evaluated on every call, and nothing carries over between calls.**

1. The request policy runs.
2. If it requires approval and `approval` is absent, the result is `approval-required`.
3. If `approval` is present, the response policy runs with `auth.current` as the responder.
4. Only then does the tool run.

A retry after sign-in passes `approval` again. There is no "already approved" input.
`callId` only correlates retries, for example for approval policies that pin the requester by call id. A
forged `callId` can make a response policy refuse, but it cannot grant anything. The prototype
carried an "approved" flag in client-held state, and a client could set it to skip approval.
This contract removes that possibility at the primitive, instead of relying on each channel.

### 3. Durable pending authorization

When `getToken` needs a sign-in, core records the attempt, bound to the session and to
`auth.current`, and returns its challenges. The provider's callback lands on eve's existing
authorization callback route rather than a route each channel defines. A later `invokeTool` with
the same `callId` completes the exchange and runs the tool.

The prototype kept pending attempts in process memory, so a callback that reached another
instance was lost. The prototype also did not check that the person completing the sign-in was
the one who started it, which MCP requires for URL-mode elicitation. Both belong in core, because
they are properties of eve's authorization machinery, not of any one protocol.

## Server: `mcpCapabilitiesChannel`

```ts title="agent/channels/mcp-capabilities.ts"
import { vercelOidc, vercelSubject } from "eve/channels/auth";
import { mcpCapabilitiesChannel } from "eve/channels/mcp";

const router = vercelSubject({ teamSlug: "acme", projectName: "router" });

export default mcpCapabilitiesChannel({
  auth: vercelOidc({ subjects: [router] }),
  trustedForwarders: (forwarder, assertion) =>
    forwarder.subject === router && isRouterUser(assertion.principal?.current),
});
```

| Option              | Meaning                                                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `auth`              | Required. The same policies as other channels, including `oauthResource(...)`.                                  |
| `route`             | Defaults to `/eve/v1/mcp-capabilities`.                                                                         |
| `trustedForwarders` | The same predicate and `ForwardedAssertion` contract as `eveChannel`. Absent: forwarded principals are refused. |

The channel only maps MCP onto the primitives:

| MCP                                                                                     | Primitive                                          |
| --------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `server/discover` (with a session key)                                                  | `prepareSession`                                   |
| `tools/list`                                                                            | `introspect().tools`                               |
| `resources/list`, `resources/read` for `skill://<agent>/<skill>/SKILL.md` and its files | `introspect().skills`, `readSkillFile`             |
| `tools/call`                                                                            | `invokeTool`                                       |
| `approval-required`                                                                     | MRTR `input_required` with a boolean approval form |
| `authorization-required`                                                                | MRTR `input_required` with URL elicitations        |

The MCP rules the channel must follow:

- Every request authenticates again. Principals come from route auth plus
  `eve-forwarded-principal`, checked by `trustedForwarders`. The session key is
  `eve-capability-session`.
- **`requestState` carries only `callId` and a binding** to the session, tool, and argument hash.
  It is never evidence that a check passed; the primitive re-evaluates everything. A retry whose
  binding does not match is rejected. The state has an expiry.
- A retry that is missing a requested answer gets `input_required` again, not a decline.
- `_meta` keys use the reverse-DNS prefix `dev.eve/`: `dev.eve/owner`, `dev.eve/approval`, and
  `dev.eve/sandbox` on discover.
- Elicitations are only sent in the modes the client declared. List results carry `ttlMs` and
  `cacheScope`, and responses are JSON only. The official SDK already enforces these.

## Client: consuming the channel

### Today

eve's MCP connections wrap `@ai-sdk/mcp` (`runtime/connections/mcp-client.ts`). The client already
speaks 2026-07-28: it calls `server/discover`, sends `Mcp-Method`, and falls back to the
`initialize` handshake for older servers (`protocolVersionDiscovery`). It does not support multi
round-trip requests: an `input_required` result fails the call with "multi round-trip requests are
not supported yet". It also has no tasks support, and eve's connections do not read resources or
keep tool `_meta` (#2727). So a connection can list and call the channel's tools, but any
approval or sign-in fails. The prototype's client was therefore userland: three tools in the
orchestrator that call MCP directly.

### Changes

1. **Multi round-trip support in the client**, wrapped behind the existing connection API: return
   `input_required` with its `inputRequests` and `requestState` instead of failing, and retry with
   `inputResponses`. This lands upstream in `@ai-sdk/mcp` or in an eve-owned wrapper.
2. **Interrupts park in the harness (core).** A connection tool call that returns `input_required`
   parks the way connection authorization already does. The harness emits `input.requested`,
   which the channel renders as it renders its own approvals, and on the answer retries the call
   with `inputResponses`. `requestState` stays in the tool call's durable state, never in model
   history. A person answers, not the model. This must be core: only the harness can park an
   ordinary tool call and resume it. The userland alternative, a workflow tool that calls
   `ctx.ask()`, works for one bespoke tool but not for connection tools in general.
3. **Forwarding and session scope.** `defineMcpClientConnection({ forwardPrincipal: true })` sends
   `eve-forwarded-principal`, with the same semantics as remote agents. The connection sends a
   session key derived from the caller's session, so one conversation keeps one provider sandbox.
4. **Skills.** A connection's `skill://` resources join the model's skill index, and `load_skill`
   reads them through the connection.

```ts title="agent/connections/analytics.ts"
import { vercelOidc } from "eve/agents/auth";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://analytics.example.com/eve/v1/mcp-capabilities",
  auth: vercelOidc(),
  forwardPrincipal: true,
});
```

Tools are found through `connection_search`, as now. Always-loaded tools are #3745's concern and
compose with this.

## Security invariants

1. Every request authenticates, and forwarded identity is accepted only through
   `trustedForwarders`.
2. Client-held state never grants authority. Approval is re-evaluated on every call.
3. The person who starts a sign-in completes it, and pending sign-ins survive instance changes.
4. The client answers interrupts with a person's input, and keeps `requestState` out of the model.
5. Sessions and sandboxes are scoped to the forwarder, the user, and the key.
6. Work is bounded: request body 1 MiB, forwarded header 16 KiB, session key 512 characters, skill
   file 512 KiB.

## Phase 2, for a separate plan

- Agents as task-returning tools (MCP tasks extension), with follow-ups through an `agentId` handle.
- One `mcpChannel` for tools, skills, and agents; its `agent_*` tools map onto tasks.
- Agents called through MCP connections, and `defineRemoteAgent` removed.
- Exposure controlled on both ends: the server advertises, the client chooses visibility.

## Validation

- Unit: introspection filters and order, session derivation, approval re-evaluation (a forged
  `callId` or missing answer never executes), request-state binding and expiry, forwarder refusal.
- Scenario: a real HTTP server covering discover and prewarm, a plain call, approval, and sign-in
  with the callback on a different instance from the retry.
- E2E: two fixture agents. One calls the other's tools through an MCP connection, including an
  approval answered through `input.requested` and a skill read.
- Interop: an official-SDK MCP client drives the channel.

## Open questions

1. Is `RouteAgent` on route args the right place, or should the primitives be importable where
   extensions can use them too?
2. Does `invokeTool` run inside a workflow when a tool needs to park, or stay request-scoped with
   durable attempts only?
3. Server-minted session handles, which SEP-2567 recommends, or the `eve-capability-session`
   header?
4. Which fields of `ctx` stay unavailable outside a turn, such as `messages`, and how does a tool
   learn it is invoked directly?
5. Should the channel let authors choose which tools it exposes, beyond excluding them by kind?

## References

- MCP 2026-07-28: [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
  [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
  [multi round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr),
  [elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation).
- [SEP-2567, sessionless MCP](https://modelcontextprotocol.io/seps/2567-sessionless-mcp);
  [SEP-2640, skills over MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md).
- eve: `docs/tools/human-in-the-loop.md`, `docs/tools/workflows.mdx` (`ctx.ask`),
  `docs/connections/mcp.mdx`; issues #2727, #2432, #3745.
