---
issue: https://github.com/vercel/eve/pull/3926
status: draft
last_updated: "2026-10-01"
---

# Tools and skills on `mcpChannel`

## Summary

An agent that routes work to specialist eve agents today can only hand them whole tasks. The
specialist runs its own model loop, and the router's model reads its prose. The gap is on the
server side. eve's MCP connections already send `tools/call` to any MCP server, but an eve agent
publishes none of its tools: `mcpChannel` offers only the `agent_*` task tools. A prototype on branch
`rui/vmcp` let an orchestrator call three specialists' tools directly instead. Replaying 24 cases
from the specialists' own eval suites twice, it matched remote subagents on pass rate (94% each),
halved median latency (15 s against 28 s), and used about a quarter of the tokens (25k against 92k).
The prototype branch has no checked-in eval harness or run logs, so these numbers are background,
not reproducible from tracked files.

This plan covers the first phase of that work:

1. **Core**: additions to the route handler surface eve already has, as TypeScript APIs only.
   `describe()` returns what the agent offers callers: its tools and skills, without deployment
   details.
   `invokeTool` runs one tool with the context it gets in a turn, inside the request and without
   parking. Each call runs in a tool session, an identity and a sandbox derived from the caller
   and a key, with no turns and no workflow run. `readSkill` reads one skill file.
2. **Server**: `mcpChannel` keeps the `agent_*` task tools and, when a deployment opts in with
   `tools: true` and `skills: true`, also publishes the agent's invocable tools and its skills,
   adapting MCP onto those operations. Clients can also subscribe to tool and skill changes over a
   server-sent stream. Phase 2 replaces the `agent_*` tools with MCP tasks.
3. **Client**: MCP connections that can consume it, including interrupts answered by a person.

Once it lands, any MCP client can call an eve agent's tools with a plain `tools/call`, the MCP
Inspector included. One MCP server per agent serves its tools and its skills; there is no second
MCP channel. Existing `mcpChannel` deployments are unaffected: they keep serving the `agent_*`
tools, and publish nothing else until they opt in; see [Compatibility](#compatibility).
`eveChannel` and `defineRemoteAgent` are unchanged. Phase 2 (#4000) replaces the `agent_*` tools
with MCP tasks, and how a calling model finds remote tools and skills is left to userland; see
[Out of scope](#out-of-scope).

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
  (`tools/call` returning a task, then `tasks/get`, `tasks/update`, and `tasks/cancel`). Phase 1
  keeps them, because clients depend on them and some, Claude Code among them, cannot consume
  MCP tasks yet; phase 2 replaces them with an MCP task once those clients have a path.
- **Identity is the direct caller.** The channel has no `trustedForwarders`; work runs as the
  authenticated principal. On `eveChannel`, forwarded identity is not a header: it is the JSON body
  field `forwardedPrincipal`, gated by `resolveForwardedPrincipal` in
  `channel/forwarded-principal.ts`, and `defineRemoteAgent` sets no header. MCP has no session
  request body to carry it, so this plan defines a header carrier; see
  [Server](#server-tools-and-skills-on-mcpchannel).

The channel already speaks stateless MCP `2026-07-28` and serves `server/discover`, so adding tools
and skills needs no transport change. What is missing is running one tool.

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
framework. Phase 1 extends route args, the right-hand column, instead of adding a separate
surface. Remote callers reach the new operations through the channel, so `eve/client` gains no
routes:

| Need                     | Remote, `eve/client`                                 | In a route handler                                   |
| ------------------------ | ---------------------------------------------------- | ---------------------------------------------------- |
| An agent's tools, skills | only inside `client.info()`, with deployment details | internal only (`readAgentInfoRouteResponse`)         |
| Create an idle session   | `client.sessions.create()`                           | internal only; `attachSession(id)` for existing ones |
| Session operations       | `ClientSession`: `send`, `stream`, `cancel`, …       | `Session`: `send`, `respond`, `cancel`, …            |
| Run one tool             | missing                                              | missing                                              |
| Read one skill file      | missing                                              | missing                                              |

On the server side, the harness loop does not change: `invokeTool` adds a tool execution scope
that comes from a request instead of a turn. The calling side does need harness work, a new
interrupt for remote `input_required`; see [Client](#client-eve-connections).

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

- **`describe()` returns `AgentDescription`**, on route args. This is what the channel publishes.
  It is a TypeScript API only; remote callers get the same data through the channel, and there
  is no new HTTP route.
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
- `invocable` is computed from what the compiled registry already records: the tool has an
  `execute`, its `behavior.handling` is not `dispatch`, `workflow-tool`, or `provider-tool`, and
  it is not a `frameworkAction`. There is no background-tool marker today; until one exists, a
  background tool is excluded only if one of those rules already covers it.
- Skill files are materialized into the workspace by `compiler/workspace-resources.ts` and are
  not in the manifest `/eve/v1/info` reads, so `describe().skills[].files` and `readSkill` need a
  lookup into the compiled resource tree.
- The order is deterministic, so callers can cache the list.
- Only compiled tools and skills are listed. Dynamic tools, skills, and connections, which
  `session.started` and `turn.started` resolvers add, are not in phase 1, so every caller sees
  the same list. This may change later.
- Subagents are not listed in phase 1.

### 2. `invokeTool` and `readSkill`

Route args gain two operations. Remote callers, other eve agents included, reach them through the
channel.

```ts
invokeTool(name: string, input: unknown, options: InvokeToolOptions): Promise<InvokeToolResult>;
readSkill(skill: string, path?: string): Promise<string | Uint8Array>; // default: SKILL.md

interface InvokeToolOptions {
  auth: SessionAuthContext; // the caller this request authenticated
  key?: string; // the caller's name for its tool session; omit for a one-off session
  callId?: string; // correlates the retries of one call
  approval?: { approved: boolean }; // the person's answer, when the caller has one
  signal?: AbortSignal;
}

type InvokeToolResult = (
  | { status: "completed"; output: unknown; modelOutput: ToolModelOutput }
  | { status: "failed"; message: string; errorId: string }
  | { status: "invalid-input"; message: string }
  | { status: "denied"; reason?: string }
  | { status: "approval-required"; callId: string }
  | {
      status: "authorization-required";
      callId: string;
      challenges: readonly AuthorizationChallenge[];
    }
) & {
  // present when the call opened the sandbox
  sandbox?: { state: "created" | "resumed" | "reused"; ms: number };
};
```

Skill reads need no session. The channel's `auth` already admitted the caller, and every caller
sees the same skills.

**Every tool call runs in a tool session**: an identity and a sandbox. It is not a conversation,
no workflow run backs it, and there is no handle to open or close. Core derives its id on every
call as `sha256(forwarder, auth.current, key)`.

- **The client defines the identity.** The key is the caller's name for the session, such as
  one per conversation. The server never mints or records one.
- **Ownership holds by construction.** Every call derives the id from its own authenticated
  principals and the key it sends, so no other caller, and no other user behind the same
  forwarder, reaches the session. A leaked key grants nothing. Nothing is stored, and no call
  reads an owner record. This meets SEP-2567's rule to check the handle against the caller on
  every call. Deriving it in core means no channel hashes ids itself.
- **No key means a one-off session.** Core mints a random one-off nonce for the call and derives
  the id as `sha256(forwarder, auth.current, "one-off:" + nonce)`, so it is still bound to the
  authenticated principals. Its sandbox is deleted when the request ends, including a request
  that ends with `approval-required` or `authorization-required`. A retry reruns the tool from
  the start in a fresh sandbox, so nothing from the first attempt is kept.

The tool sees the same `ctx` it sees in a turn:

- `ctx.session.id` is the tool session. `ctx.session.auth.current` is the caller.
  `.initiator` is the initiator the request asserts, or the caller when it asserts none. No
  record pins a creator.
- `ctx.getSandbox()` opens the session's sandbox.
- `ctx.getToken()` resolves the user's grant, and returns `authorization-required` when a sign-in
  is needed.
- `ctx.session.turn` is a stand-in for the call, `{ id: callId, sequence: 0 }`, because there is
  no turn. `turn` stays required in `SessionContext`, so existing tools that read
  `ctx.session.turn.id` keep compiling and get one id per call. eve already uses a stand-in turn
  when it sets up a sandbox outside a turn. `ctx.session.parent` is absent; it is already
  optional.

**A tool session reuses one sandbox across calls.** Conversations store the provider's sandbox
state after their first step and resume it. A tool session stores nothing, so every call
recomputes the same sandbox name from the session id and finds or creates the sandbox by that
name:

```text
call 1  id = sha256(router, Alice, K) → ctx.getSandbox() → name N from id → get(N): none → create(N)
          side effect: sandbox N running; the tool writes /workspace/…/result.csv, returns its path
call 2  same id → same N → get(N): found → reuse; the tool reads the path call 1 returned
```

- **The sandbox starts lazily**, on the first `ctx.getSandbox()`. Tools that never call it,
  and callers that never use those tools, start nothing. There is no prewarm in phase 1.
- **The sandbox is persistent.** On Vercel, the sandbox timeout bounds one running session's
  duration: 5 minutes by default, extendable up to 45 minutes on Hobby and 24 hours on Pro. It is
  not the sandbox's lifetime. A stopped sandbox keeps its filesystem as a snapshot, and the next
  call resumes it, so files one call writes stay available to later calls with the same key.
- **Retention is bounded, because a tool session has no end** to delete its sandbox. Vercel
  snapshots expire after 30 days, and a sandbox that can no longer resume is removed after 14 days
  idle. eve adds its own bound: tool-session sandboxes carry the tag `eve:tool-session`, the
  tool-session expiry defaults to the 30-day snapshot expiry, and a sweep runs every 7 days and
  deletes those unused past it. A call after that finds no sandbox and creates an empty one, and a
  path from an earlier result then fails with the tool's own error.
- **Concurrent first calls must converge on one sandbox.** Parallel calls on different instances
  can all find no sandbox. `Sandbox.getOrCreate({ name })` does not solve this: it is a get, then
  a create on 404, not an atomic operation. eve wraps it: a create that fails with a name conflict
  retries the get and reuses the winner. Today eve deduplicates concurrent starts only within one
  process.
- **A new sandbox template changes the name**, because the name includes it. The first call
  after such a deployment starts a new sandbox; the old one ages out.

**A tool session has none of these**, and the channel documentation must say so:

- **No turns and no steps.** No call is wrapped in a turn or a step; the stand-in turn only
  names the call. Dynamic resolvers do not run (section 1).
- **No authored session state.** `defineState` belongs to conversations, where step boundaries
  give its updates a commit point. A tool session has no such point: `get()` returns the declared
  initial value, and `update()` throws an error that names the tool. State that must outlive a
  call lives in the sandbox, or behind a handle the tool returns, the pattern SEP-2567
  recommends.
- **No ordering between calls.** Calls may run in parallel, as MCP `tools/call` requests and a
  model's parallel tool calls already can. Nothing serializes them.
- **No at-most-once guarantee.** A call retried after a lost response runs again. In a turn,
  durable steps prevent that. A tool session keeps no record to check against, like any
  stateless MCP server: MCP notes that bounding replay does not make state single-use, and that
  an operation that must happen at most once needs a server-side record.
- **No model, instructions, history, or messages.**

**Tools run inside the request and never park.** Parking exists so that a turn can wait for a
person. MCP's multi round-trip requests already move that wait to the client: the call ends with
`input_required`, and the client retries with the answer. A stateless function can serve each
retry. So no call state outlives a request, and no workflow step wraps a call. A tool that needs
longer than one request is an agent task, which belongs to phase 2.

**Approval is evaluated on every call, and nothing carries over between calls.** This is new
code. Today the response policy runs only in `harness/approval-delivery-coordinator.ts`
(`authorizeCandidate`), when a response is delivered to a pending request; nothing evaluates it
before `execute`. `invokeTool` adds that pre-execute evaluation:

1. The request policy runs.
2. If it requires approval and `approval` is absent, the result is `approval-required`.
3. If `approval` is present, the response policy runs with the caller as the responder. A
   `rejected` response is `denied`. In a conversation it leaves the request pending for another
   eligible responder, but a tool session has no pending request to leave.
4. Only then does the tool run.

A retry after sign-in passes `approval` again. There is no "already approved" input. `callId`
only correlates retries, for example for approval policies that pin the requester by call id. A
forged `callId` can make a response policy refuse, but it cannot grant anything. The prototype
carried an "approved" flag in client-held state, and a client could set it to skip approval.
This contract removes that possibility at the primitive, instead of relying on each channel.

**In phase 1, sign-in requires a provider that runs the OAuth flow.** In a turn, a sign-in parks
the tool and emits `authorization.required` (`harness/tool-loop.ts`), not `input.requested`. A tool
session cannot park. When `getToken` needs a
sign-in, the result is `authorization-required` with the strategy's challenge, and the retry runs
the tool from the start. The retry succeeds only if `getToken` can then find the grant. MCP's
URL-mode flow shows what that takes: a server records the pending authorization for the user,
checks that the browser's user is that user, receives the redirect, exchanges the code, and
stores the tokens for that user. The redirect comes from the browser, not the MCP client, so it
carries no `requestState`, and a tool session keeps nothing between requests.

- **Supported: strategies whose provider runs that flow**, such as Vercel Connect. Its
  `startAuthorization` returns only a challenge, and its `completeAuthorization` reads the same
  grant `getToken` does, so eve holds nothing between the challenge and the retry. The callback
  URL eve passes is only the page the browser lands on.
- **Not supported: strategies that return `resume`**, such as a PKCE verifier. They need a record
  of the pending sign-in until the code arrives. In a tool session, a `startAuthorization` that
  returns `resume` fails the call with an error that names the connection and says why.
  Conversations are unaffected. The current pilot does not require these strategies, so phase 1
  leaves them out.
- **A retry before the sign-in finishes gets `input_required` again.** In URL mode, `accept`
  means only that the person opened the page.
- **Nothing checks that the person completing a sign-in is the one who started it.** MCP
  requires this check for URL-mode elicitation. Connect does not make it. The subject is an id
  the calling project asserts with its OIDC token, not an identity Connect can authenticate in
  the browser. Whoever completes the provider sign-in grants that subject access. So a link
  someone else completes grants the requesting user access through that other person's
  provider account. Conversations with Connect behave the same way today. Phase 1 does not
  change this, and closing the gap belongs to Connect and eve's Connect adapter.
- **Retries rerun the tool from the start.** Tools should resolve credentials before side effects.

## Server: tools and skills on `mcpChannel`

```ts title="agent/channels/mcp.ts"
import { vercelOidc, vercelSubject } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";

const router = vercelSubject({ teamSlug: "acme", projectName: "router" });

export default mcpChannel({
  auth: vercelOidc({ subjects: [router] }),
  // Opt in: without these, the channel serves only the `agent_*` tools, as it does today.
  tools: true,
  skills: true,
  // Check both identities: on session creation the asserted initiator becomes auth.initiator.
  trustedForwarders: (forwarder, assertion) =>
    forwarder.subject === router &&
    assertion.principal !== undefined &&
    isRouterUser(assertion.principal.current) &&
    isRouterUser(assertion.principal.initiator),
});
```

| Option              | Meaning                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`              | Required, unchanged. The same policies as other channels, including `oauthResource(...)`.                                                 |
| `route`             | Unchanged. Defaults to `/eve/v1/mcp`.                                                                                                     |
| `tools`             | New. Defaults to `false`. `true` also publishes the agent's invocable tools, with tool sessions and change notifications.                 |
| `skills`            | New. Defaults to `false`. `true` publishes the agent's skills (SEP-2640).                                                                 |
| `trustedForwarders` | New. The same predicate and `ForwardedAssertion` contract as `eveChannel`, for published tools and skills. Absent: the header is ignored. |

The channel is an adapter. Each MCP method maps onto one of the operations above:

| MCP                                                                          | eve                                                      |
| ---------------------------------------------------------------------------- | -------------------------------------------------------- |
| `server/discover`                                                            | as today, plus the extensions and capabilities it serves |
| `dev.eve/tool-sessions` extension, below                                     | the `key` option of `invokeTool`                         |
| `tools/list`                                                                 | `describe().tools`, invocable only                       |
| `skills/list`, `skills/get` (SEP-2640)                                       | `describe().skills`                                      |
| `resources/read` for `skill://<skill>/SKILL.md` and `skill://<skill>/<file>` | `readSkill`                                              |
| `resources/directory/read` for `skill://<skill>`                             | `describe().skills[].files`                              |
| `tools/call`                                                                 | `invokeTool`                                             |
| `subscriptions/listen`                                                       | change notifications, below                              |
| `approval-required`                                                          | MRTR `input_required` with a boolean approval form       |
| `authorization-required`                                                     | MRTR `input_required` with URL elicitations              |

The MCP rules the channel must follow:

- Every request authenticates again. Principals come from route auth plus the
  `eve-forwarded-principal` header, checked by `trustedForwarders`. The tool session is derived
  from those principals and the key the call sends.
- **The forwarded principal travels in a header.** `eve-forwarded-principal` carries the
  `ForwardedPrincipal` JSON (`{ current, initiator? }`, the same shape as `eveChannel`'s body
  field), encoded as unpadded base64url of its UTF-8 bytes, at most 16 KiB encoded. The channel
  decodes it and passes it to `resolveForwardedPrincipal`, so parsing, stamping
  `eve:forwarded-by`, and the `trustedForwarders` check are shared with `eveChannel`. A header
  that does not decode or parse fails the request; it is never silently dropped once a
  `trustedForwarders` predicate is set. A header, not `_meta`, because it applies to every
  request, `server/discover` and `resources/read` included, and deployment protection and
  proxies can see it.
- **`requestState` is signed.** It carries `callId`, the tool-session id, the tool name, the
  argument hash, and an expiry, plus the one-off nonce when the call has no key. The channel
  HMAC-signs it with a deployment secret shared by every instance, so any instance can verify a
  retry. On a retry the channel re-derives the session id from the request's own principals and
  its key, or from the signed nonce when there is none, and requires it to equal the signed id. A
  retry whose signature, binding, or expiry does not check out is rejected, so a state lifted
  from another caller or forwarder fails on the binding even with a valid signature. A valid signature is still
  never evidence that a check passed; the operation re-evaluates everything. Signing stops a
  client from minting or editing state, which the prototype's unsigned approved flag allowed.
- A retry that is missing a requested answer gets `input_required` again, not a decline.
- `_meta` keys use the reverse-DNS prefix `dev.eve/`, such as `dev.eve/owner` and
  `dev.eve/approval`.
- Elicitations are only sent in the modes the client declared. List results carry `ttlMs` and
  `cacheScope`, and responses are JSON, except the `subscriptions/listen` stream. The official SDK
  already enforces these.
- Skills follow SEP-2640. The channel declares `io.modelcontextprotocol/skills`, and the last
  segment of a skill path is the skill's `name`. The server already scopes the URI, so it carries
  no agent prefix.

### Tool sessions over MCP

MCP has no session API. SEP-2567 removed sessions and forbids list results that vary per
connection, so a session cannot ride on `server/discover`. The channel carries the key in a
vendor extension instead, which clients opt into per request:

- **The channel advertises `dev.eve/tool-sessions`** in `server/discover`. The advertisement is
  the same for every caller, so discover stays cacheable.
- **A client that declares it sends `_meta["dev.eve/tool-session"]`** with its key on
  `tools/call` and `resources/read`, retries included. `requestState` binds to the key. There
  is no setup request: the first call carries the key, and nothing may depend on an earlier one.
- **A client that does not declare it gets a one-off tool session per call**, as the
  extensions guidance asks: the fallback is core behavior, not an error. Its approval and sign-in
  retries carry the nonce in the signed `requestState`, as above, and can land on any instance.
  Skill reads need no session.
- **Results report the sandbox** in `_meta["dev.eve/sandbox"]`, as `{ state, ms }` from
  `invokeTool`, when the call opened it. Clients that do not know the key ignore it. The same
  fields go on the server's trace spans.

This deviates from the Transports WG's decision on application sessions. Its maintainers chose
explicit state handles that servers return in tool results, with the client passing them back as
arguments, over a session id in the protocol envelope. A client-defined key in `_meta` is closer
to the rejected option. The channel still follows the handle pattern for state: in the pilot, a
query tool returns a sandbox path, and an analysis tool takes it as an argument. The key only
selects which sandbox those paths refer to. A handle minted by the server would need a
create tool and a session argument on every sandbox tool. It would also depend on the model
passing it along, and split state when parallel first calls each mint their own. The WG is
still collecting use cases for an id generated by the client (transports-wg#36, after
SEP-2822 closed). If it standardizes one, the channel accepts it as the key and keeps
`dev.eve/tool-session` as an alias.

### Change notifications

Clients can subscribe to changes instead of polling. The channel declares `tools.listChanged`,
`resources.listChanged`, and `resources.subscribe`, and serves `subscriptions/listen`. The spec
defines it as one long-lived SSE stream per subscription, replacing `resources/subscribe` and the
HTTP `GET` endpoint:

| Filter in `notifications`                                  | Server sends                           | When                                                           |
| ---------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------- |
| `toolsListChanged`                                         | `notifications/tools/list_changed`     | the invocable tools `describe()` returns to this caller change |
| `resourcesListChanged`                                     | `notifications/resources/list_changed` | the skills or their files change                               |
| `resourceSubscriptions: ["skill://usage-triage/SKILL.md"]` | `notifications/resources/updated`      | that file changes                                              |

- The first message is `notifications/subscriptions/acknowledged`, listing only the filters the
  channel honors.
- The stream authenticates like every request, and carries notifications only about tools and
  resources that the caller can list or read.
- The function's maximum duration bounds the stream. At the limit, the channel closes the
  transport without a completion result, which the spec treats as a disconnect that the client
  may reconnect from. A completion result would tell the client the subscription ended on
  purpose. After reconnecting, the client lists again, which also picks up a new deployment
  behind the same URL.
- Notifications invalidate caches. List results still carry `ttlMs` for clients that do not
  subscribe.

In phase 1, lists change only when a new deployment starts serving the URL. Within a deployment
they are fixed, because only compiled tools and skills are listed. An open stream belongs to the
old deployment, so it never carries a notification. It ends, the client reconnects, and its next
list shows the new deployment. Notifications within a deployment wait until something there can
change, such as dynamic tools.

### Calling it from any MCP client

The channel is a plain MCP `2026-07-28` server, so nothing on the calling side has to be eve. Under
`eve dev` with `mcpChannel({ auth: localDev() })`, the MCP Inspector CLI
can list and call an agent's tools and read its skills:

```sh
URL="http://localhost:2000/eve/v1/mcp" # the URL `eve dev` prints
mcp() { npx @modelcontextprotocol/inspector --cli --transport http --server-url "$URL" "$@"; }

mcp --method tools/list
mcp --method tools/call --tool-name query_usage \
  --tool-args-json '{"account":"acme","window":"30d"}'
mcp --method skills/list
mcp --method resources/read --uri skill://usage-triage/SKILL.md
```

- `tools/list` returns the invocable tools, with their input and output schemas.
- `tools/call` runs the tool as the authenticated caller and returns `structuredContent`. A
  failing tool returns `isError: true`, and the Inspector exits `5`.
- The Inspector does not declare `dev.eve/tool-sessions`, so each call runs in a one-off tool
  session, and its sandbox does not outlive the call.
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
round-trip requests: as of `@ai-sdk/mcp` 2.0.64, an `input_required` result throws "multi
round-trip requests are not supported yet", and there is no upstream pull request adding it. It also has no tasks support, and eve's connections do not read resources or
keep tool `_meta` (#2727). So a plain `tools/call` works today, and a connection could list and
call the channel's tools once it exists, but any
approval or sign-in fails. The prototype's client was userland because of these gaps: three
tools in the orchestrator that call MCP directly.

### Changes

1. **Multi round-trip support in the client**, wrapped behind the existing connection API: return
   `input_required` with its `inputRequests` and `requestState` instead of failing, and retry with
   `inputResponses`. Phase 1 ships this as an eve-owned wrapper around `@ai-sdk/mcp`, and opens an
   upstream `vercel/ai` issue in parallel; the wrapper goes away if upstream lands it.
2. **The calling turn waits for its user (core).** Say Alice asks the router agent a question,
   and the router calls the analytics agent's `run_query`, which needs approval. Analytics
   answers `input_required` and forgets the call. Someone has to ask Alice and wait for her.
   Only the router can: its turn is durable. It already parks when a connection needs Alice to
   sign in, but that path emits `authorization.required` for the connection's own grant. A remote
   `input_required` is a new typed interrupt and continuation in the harness, not a reuse of it.
   So the router's harness:
   1. parks the turn and emits `input.requested`, which Alice's channel shows like any approval;
   2. when Alice answers, calls `run_query` again with her answer (`inputResponses`) and the
      `requestState` analytics returned.

   Alice answers, not the model, and the model never sees `requestState`. This has to be core
   because a connection tool is an ordinary tool call, and only the harness can pause one and
   resume it. Userland can do this for one hand-written workflow tool with `ctx.ask()`, but not
   for every connection tool.

   Two rules hold wherever the question is asked:
   - **Only Alice's answer counts.** In a shared thread, Bob can click Approve. The provider
     treats every answer as Alice's, because hers is the forwarded identity, so the caller checks
     that the answer's `responder` is the forwarded user and refuses any other.
     `ToolInputRequest` names no expected responder today, so a channel that cannot report the
     responder fails the call. Slack and Teams report the responder. Discord components and
     Telegram callback buttons deliver answers with `auth: null`, so on those channels a remote
     approval always fails closed in phase 1.
   - **No person, no retry.** A caller with no input surface, such as a scheduled run, gets
     `unavailable` from `ctx.ask()`. The call then fails with an error that names the tool
     instead of asking again. Re-asks after an unfinished sign-in are bounded.

3. **Forwarding and session scope.** `defineMcpClientConnection({ forwardPrincipal: true })` sends
   the `eve-forwarded-principal` header, encoded as in [Server](#server-tools-and-skills-on-mcpchannel),
   with the same principals remote agents put in their `forwardedPrincipal` body field. The connection declares
   `dev.eve/tool-sessions` and sends a key derived from the caller's session, so one conversation
   keeps one provider sandbox.
4. **Change notifications.** A connection may subscribe with `toolsListChanged` and
   `resourcesListChanged` to invalidate its cached tool and skill lists, instead of relying only
   on `ttlMs`.

```ts title="agent/connections/analytics.ts"
import { getVercelOidcToken } from "@vercel/oidc";
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://analytics.example.com/eve/v1/mcp",
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
and the choice between materialized connection tools and one dispatch tool are later work. They
can be built in userland on top of this phase, as the prototype's `discover`, `load_skill`, and
`tool_call` tools were.

## Compatibility

Phase 1 does not change what an existing `mcpChannel` serves:

- **The `agent_*` tools stay.** `agent_start`, `agent_get`, `agent_update`, and `agent_cancel`
  keep working as today, including for clients such as Claude Code that cannot consume MCP tasks.
  They act for the route-authenticated caller; a forwarded principal applies to published tools
  only.
- **Tools and skills are opt-in.** `tools/list` adds the agent's invocable tools only with
  `tools: true`, and skills are served only with `skills: true`. Once enabled, every caller the
  channel's `auth` admits can call those tools directly, as themselves, outside the agent's model
  loop and instructions, with approval policies enforced.
- **The `agent_*` names are reserved.** With `tools: true`, the `agent_*` tools are listed first,
  exactly as without it, and an authored tool with one of their names is not published.
- **Unchanged:** the route, `auth`, body limits, the streamable-HTTP transport, and
  `server/discover`; `2025-11-25` clients still connect through `initialize`. `eveChannel` and
  `defineRemoteAgent` are untouched.
- `SessionContext.turn` stays required, so authored tools compile as before.

To publish tools and skills:

1. Review what becomes callable, then set `tools: true` and `skills: true`.
2. Expect a sandbox per caller and key for tools that use one, retained as described in
   section 2.
3. Add `trustedForwarders` only if another deployment forwards its users.

Removing the `agent_*` tools is phase 2 work (#4000). It waits until their clients have a
replacement.

## Security invariants

1. Every request authenticates, and forwarded identity is accepted only through
   `trustedForwarders`, from the `eve-forwarded-principal` header.
2. Upgrading never widens what a channel publishes: tools and skills stay off until the
   deployment opts in.
3. Client-held state never grants authority. `requestState` is HMAC-signed and bound, and
   approval is re-evaluated on every call.
4. No call state outlives a request, and eve keeps no record of a tool session. In phase 1,
   sign-in requires a provider that runs the OAuth flow.
5. The client answers interrupts only with the forwarded user's input, fails when nobody can
   answer or the channel cannot name the responder, and keeps `requestState` out of the model.
6. A tool session is derived from the forwarder, the user, and the key, so a caller reaches only
   its own sessions and sandboxes.
7. MCP callers see only `AgentDescription`. The inspection payload from `info()` never reaches
   them.
8. Work is bounded: request body 1 MiB, forwarded header 16 KiB, tool-session key 512 characters, skill
   file 512 KiB, 100 resource URIs per subscription, and a bounded number of open subscriptions
   and live tool-session sandboxes per caller.
9. Tool-session sandboxes start only when a tool uses one, and their retention is bounded by an
   expiry and a sweep.

## Out of scope

- Phase 2: agents return as MCP tasks, a task-returning agent tool over the MCP tasks extension
  (SEP-2663). Its requirements are tracked in #4000. `defineRemoteAgent` and `eveChannel` are not
  changed by phase 1.
- Client-side discovery: search, visibility, remote skills, and connection calls from authored
  tools.
- Sandbox prewarm. Warming every dependency's sandbox at the start of each calling session
  would start sandboxes most sessions never use. The prototype's one measurement was
  inconclusive: the first sandbox call after its warm-up still took 4.3 s, against 0.5 s warm.
  Phase 1 measures first calls through `dev.eve/sandbox` before deciding whether to add a
  targeted warm-up.
- Tabled: choosing individual tools, beyond the invocable filter. Until then, `tools: true`
  publishes every invocable tool to every caller the channel's `auth` admits, with approval
  policies still enforced. Leave `tools` off for agents whose tools are not safe to call
  directly.
- Sign-in strategies that return `resume`, and the Connect completer-identity check; see
  section 2.

## Validation

- Unit: `describe()` (no inspection fields, invocable filter, order), approval
  re-evaluation (a forged `callId` or missing answer never executes, and a `rejected` response
  is `denied`), `requestState` signature, binding, and expiry (an edited or unsigned state is
  rejected), session ownership, forwarder refusal.
- Unit: one-off retries. Without the extension, an approval retry verifies on a second instance
  sharing only the secret; the same `requestState` replayed by another user or forwarder is
  rejected on the binding; and the first attempt's sandbox is deleted before the retry runs.
- Unit: `mcpChannel` defaults. With `auth` only, it serves the `agent_*` tools and nothing else.
  `tools: true` / `skills: true` add tools and skills to `tools/list`, `server/discover`, and the
  skill methods, list the `agent_*` tools exactly as without them, and reserve their names.
- Unit: forwarding. Without `trustedForwarders`, the header is ignored and work runs as the
  caller. With it, a malformed or oversized header fails the request. A tool that reads
  `ctx.session.turn.id` gets the call's stand-in turn under `invokeTool`.
- Unit: tool session semantics. The same key from another user or forwarder reaches a different
  session, dynamic resolvers never run, state reads return initial values and writes throw, two
  calls run in parallel, and a strategy that returns `resume` fails with an error naming the
  connection.
- Scenario: a subscription that is acknowledged, closes at its duration limit without a
  completion result, and lists again after reconnecting.
- Scenario: a real HTTP server covering discover, a plain call, approval, a provider-run sign-in
  whose retry lands on a different instance, and the one-off fallback for a client without the
  extension.
- Scenario: sandbox reuse. Two calls with one key share a sandbox, reported `created` then
  `reused`. A call after the sandbox stops reports `resumed` and reads the file an earlier
  call wrote. Concurrent first calls end up in one sandbox through conflict-and-retry, and a tool
  that never opens the sandbox starts none.
- Measurement: first-call latency from `dev.eve/sandbox` for `created`, `resumed`, and `reused`
  against a deployed agent, which decides whether prewarm comes back.
- E2E: two fixture agents. One calls the other's tools through an MCP connection, including an
  approval answered through `input.requested` and a skill read.
- Unit (client): an approval answered by a second user in the thread is refused, an answer with
  `auth: null` fails the call, and `unavailable` from `ctx.ask()` fails the call without asking
  again.
- Interop: the MCP Inspector CLI lists, calls, and reads skills against a fixture, as in
  [Calling it from any MCP client](#calling-it-from-any-mcp-client).

## References

- MCP 2026-07-28: [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog),
  [tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools),
  [multi round-trip requests](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr),
  [elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation),
  [subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions).
- [SEP-2567, sessionless MCP](https://modelcontextprotocol.io/seps/2567-sessionless-mcp);
  [SEP-2640, skills over MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2640-skills-extension.md);
  [SEP-2663, tasks](https://modelcontextprotocol.io/seps/2663-tasks-extension).
- Sessions: [Transports WG decision on application sessions](https://github.com/modelcontextprotocol/transports-wg/blob/main/docs/sessions-vs-sessionless-decision.md);
  [transports-wg#36](https://github.com/modelcontextprotocol/transports-wg/issues/36);
  [SEP-2822, client-generated session id (closed)](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2822).
- [MCP Inspector CLI](https://github.com/modelcontextprotocol/inspector/blob/main/clients/cli/README.md).
- eve: `docs/tools/human-in-the-loop.md`, `docs/tools/workflows.mdx` (`ctx.ask`),
  `docs/connections/mcp.mdx`; issues #2727, #2432, #3745.
