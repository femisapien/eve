---
issue: TBD
status: proposed
last_updated: "2026-09-27"
---

# Native code mode

## Summary

eve replaces `connection_search` and the `workflow()` tool with one code
tool, `execute`. The model writes a short JavaScript program that calls
connection tools, spawns subagents, and calls any authored tools that opt
in, all through a typed `tools` object, and then composes the results.
Those tools never enter the provider `tools` array. Connecting,
authorizing, or discovering them never breaks the prompt cache. Today, every
successful `connection_search` breaks the whole cached prefix.

- **Scope.** This ships as default behavior, with no flag. Framework tools
  stay direct.
- **Subagents.** `workflow()` merges into `execute`. Everything it covers
  moves to `tools.agents.<name>(...)`, and `workflow()` is removed in the
  same release, so models never see two JavaScript tools.
- **Catalog.** The catalog arrives as append-only conversation messages, and
  the `execute` description never changes.
- **Nested calls** go through the existing harness tool path: connection
  approvals, authorization, tracing, and protocol events. A call that must
  wait for a person or a sign-in parks the program durably. The program then
  resumes from a replay ledger.
- **Authored tools** opt in with `defineTool({ codeMode: true })` and must
  declare an `outputSchema`. Connection tools without output schemas are
  typed `unknown` rather than rejected.
- **Ship gate.** Measured cache reuse, model calls, and task success gate
  the release against today's `connection_search` baseline.

This is also the substrate for skill sets. Activating one appends a catalog
namespace instead of rewriting the `tools` array.

## Why now

- **One agent that activates capabilities.** V showed that routing work to
  specialist subagents fails in ways that are hard to undo. The direction is
  one agent that pulls in specialist capability when it needs it. That is only
  affordable if activation does not bust the cache, and mutating the `tools`
  array always does.
- **The AI SDK shipped code mode.** `@ai-sdk/code-mode` provides a QuickJS
  runtime with interrupts, approvals, and signed continuations. eve already
  vendors 1.0.62 and uses it in the `workflow` tool.
- **Output types are available.** Composition needs known output types. MCP
  output schemas, OpenAPI response schemas, and authored schemas provide
  them.

## Current state

**Any tool change invalidates the full cache.** `prepareModelTools`
(`harness/tool-loop.ts`) rebuilds the `ToolSet` every step. Providers
render tools before the system prompt and messages, so any change to the
`tools` array invalidates the entire cached prefix. eve places Anthropic
breakpoints on the last tool, the system prompt, and the conversation tail
(`harness/prompt-cache.ts`). None of them survive a tool change.

**`connection_search` busts the cache on every hit.**
(`execution/tools/connection-search.ts`)

- Each discovered tool is added to the `tools` array on the next step as
  `<connection>__<tool>`, which invalidates the cached prefix.
- Each schema is paid for twice: once in the search result, once in the tool
  definition.
- The tool exists only while connections are registered. A dynamic
  connection that appears or disappears mid-session also changes the
  `tools` array.
- Matching is naive token overlap.
- A tool cannot be discovered and called in the same step.

**The append-only channel leaks.** Dynamic skill changes are appended as
framework `context.state` user messages (`harness/current-messages.ts`). When
the tail message is an approval response, the text falls back to a system
message, which breaks the cache.

**Pieces to build on**

- **Durable code mode.** The `workflow` tool already runs model-written
  JavaScript in QuickJS as a pure step. Each `ctx.agent()` call becomes an
  interrupt, and the program resumes from a signed continuation. The signing
  key is created in a durable step (`execution/dynamic-workflow/`).
- **MCP output schemas.** MCP connections forward the server's
  `outputSchema` when one exists.
- **Untyped OpenAPI results.** OpenAPI connections declare no output schema.
  They return `{ status, statusText, body }` untyped, even when the spec
  describes the response.

## Prior art

Sources:

- opencode v2: branch `v2` at
  [`c0d49f1`](https://github.com/sst/opencode/tree/c0d49f101c3079f4fb3f08af4026fb5cb0873745).
  The `dev` branch is v1.
- `@ai-sdk/code-mode`: `vercel/ai` at `5d12eaa`, 1.0.75. It has the same API
  as eve's 1.0.62. See the [docs](https://ai-sdk.dev/docs/ai-sdk-core/code-mode).

|                   | opencode v2                                        | AI SDK code mode                                      | eve (proposed)                                       |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| Model surface     | `execute` plus direct built-in tools               | one code tool, routed by `experimental_toolCallers`   | `execute` plus direct framework tools                |
| Routed into code  | all MCP tools by default; opt-out per server       | tools whose callers include code mode                 | connection tools; subagents; opted-in authored tools |
| Runtime           | in-process acorn AST interpreter                   | QuickJS in worker threads (`run`)                     | AI SDK runtime                                       |
| Catalog placement | session baseline plus appended deltas              | tool description (default) or appended full catalog   | appended baseline plus deltas                        |
| Discovery         | budgeted inline listing plus `search()` in program | full declarations; `toolSearch()` outside the program | budgeted listing plus `search()` in program          |
| Unknown outputs   | `Promise<unknown>`                                 | `Promise<unknown>`                                    | `Promise<unknown>`                                   |
| Nested approvals  | same permission path as direct calls               | callback, or signed interrupt (undocumented)          | harness approval path; parks durably                 |
| Limits            | none set by core                                   | 30 s, 64 MB, 256 calls, 1 MB result                   | AI SDK defaults                                      |
| Nested visibility | progress on the parent call                        | none                                                  | protocol actions with `parentCallId`                 |

**opencode v2**

- **Tool split.** Every built-in tool is direct (`codemode: false`): read,
  edit, write, patch, shell, glob, grep, webfetch, websearch, question,
  skill, and subagent (`core/src/tool/plugin/`).
  - Code mode holds all MCP tools plus five opencode-owned tools: session
    rename and move, model search, and MCP resource list and read.
  - Servers that run their own code mode are opted out automatically.
- **Invariant description.** The `execute` description contains runtime rules
  only.
- **Catalog.** `codemode/catalog.ts` lists every namespace with its tool
  count, then inlines signatures round-robin up to about 2,000 tokens. The
  model reaches the rest through a synchronous `search()`.
- **Catalog updates.** Changes append as deltas (`session/instruction-state.ts`),
  and the baseline resets only at compaction. On AI SDK provider routes,
  deltas become escaped `<system-update>` user messages
  (`ai/src/protocols/shared.ts`), the same shape as eve's `context.state`.
- **MCP results.** A program receives `structuredContent` when present,
  otherwise text. JSON-looking text is parsed when the tool declares no
  output schema.
- **What not to copy.** opencode sets no limits, and adds a `fetch` global
  with no permission check or SSRF guard.

**AI SDK**

- **Replay ledger.** On resume, `run` reads completed host calls from the
  ledger instead of re-invoking them. It keeps guest `Date.now()` and
  `Math.random()` deterministic, and rejects divergent replays. Calls first
  reached after the recorded frontier run normally, which allows "run inline,
  interrupt only to park."
- **Host-owned rendering.** `experimental_runCodeMode` lets the host own the
  description and catalog rendering.
- **Default cache behavior.** The default discovery mode, `"description"`,
  embeds the catalog in the tool description and breaks the cache on any
  change. Local `toolSearch()` adds discovered tools to the `tools` array
  (`ai/src/tool-search/prepare-tool-search.ts`), which breaks the cache the
  same way `connection_search` does.

**Others**

- [Cloudflare Code Mode](https://developers.cloudflare.com/agents/tools/codemode/)
  runs programs in Worker isolates and adds in-program `search()` and
  `describe()`.
- Anthropic's
  [programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)
  and
  [tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)
  are provider-native equivalents. They are possible future backends, but
  they don't work across providers.

## Principles

1. **Code mode is a routing decision, not a mode.** One code tool sits beside
   the direct tools models are trained on. Each capability is reachable
   exactly one way, which satisfies "no multiple modes" from the model's
   side.
2. **Catalog placement protects the cache, not code mode itself.** Three
   things must hold: a description that never changes, a catalog that only
   appends, and a new baseline only at compaction. The AI SDK default breaks
   the first by embedding the catalog in the tool description.
3. **Unknown outputs limit composition, not calls.** A program that returns
   `await tools.x.y(input)` is equivalent to a direct call and keeps the cache
   intact. Rejecting tools without schemas would forfeit the cache win for
   most MCP servers.
4. **Search belongs inside the program.** Discovering and calling a tool in
   one `execute` call changes nothing in the `tools` array.
5. **Durability reuses what exists.** `run`'s replay ledger maps onto eve's
   parking model (approval, OAuth, and durable waits), and the `workflow`
   tool already exercises it.

## Design

### Model surface

**`execute({ js })`**

- **Fixed description.** The description is fixed per eve version. It states
  the runtime rules, tells the model to prefer connected services over web
  search or general knowledge, and never names a tool or connection.
- **Presence.** `execute` exists when the agent declares any of these:
  a connection, a dynamic connection resolver, a subagent, a dynamic
  subagent resolver, or a code-mode tool. The compiler decides this, so
  `execute` never appears or disappears mid-session. An empty catalog says
  so.
- **Closed and required.** `execute` replaces `connection_search` in the
  required framework slot. It cannot be disabled or overridden.
  - An authored `agent/tools/execute.ts` is a compile error.
  - So is `agent/tools/connection_search.ts`, whose error names `execute` as
    the replacement.
  - `workflow()` and the `eve/tools/workflow` export are removed. An agent
    that still imports it gets a compile error naming `tools.agents.*` in
    `execute` as the replacement.
- **Naming in docs.** Docs call it "the code mode `execute` tool" to
  distinguish it from a tool definition's `execute` function.

**Program globals**

- `tools.<namespace>.<name>(input)`
- A synchronous `search({ query?, namespace?, limit?, offset? })` over the
  catalog.
- `console`
- No `fetch`, filesystem, timers, or imports. HTTP and files go through tools
  that enforce eve's authorization, SSRF, and sandbox policies.

**Result**

- The model receives the JSON return value, captured logs, and a summary of
  nested calls.
- Errors are returned as data with suggestions, such as "Did you mean
  `tools.linear.list_issues`?", or the available namespaces when a
  connection name is wrong.

**Direct tools.** Every other framework tool stays direct and unchanged:

- `bash`, `read_file`, `write_file`, `glob`, and `grep`,
- `web_fetch` and `web_search`,
- `load_skill`,
- subagent tools,
- `ask_question` and `task_cancel`,
- the final output tool.

No tool is reachable both directly and from code. Subagents are the one
case with two forms, and they serve different purposes:

- A direct subagent tool starts a background task and returns a receipt.
- `tools.agents.<name>(...)` blocks the program until the child's output is
  available to compose.

**Skills** keep their listing and `load_skill`. Skill-list updates follow the
same append-only rule as the catalog. `load_skill`'s hint for connection
names points to `search({ namespace })` inside `execute`.

### Catalog

**Namespaces** derive from file paths, and collisions are compile errors.

| Source            | Path                                                        |
| ----------------- | ----------------------------------------------------------- |
| Connection tools  | `tools.<connection>.<tool>`                                 |
| Subagents         | `tools.agents.<name>({ message, agentId?, outputSchema? })` |
| Opted-in authored | `tools.<tool>`                                              |
| Extension tools   | `tools.<extension>.<tool>`                                  |

`agents` is a reserved namespace. A connection or tool named `agents` is a
compile error.

**Subagents in `execute`** cover everything `workflow()` does today:

- **Returns output.** A call resolves directly to the child's
  JSON-serializable output, with no metadata wrapper. When `outputSchema` is
  given, the output is validated against it.
- **Continues a child.** Passing an `agentId` from the conversation's
  `<agents>` block continues that child. Omitting it starts a new child
  session.
- **Same checks.** The owning agent resolves the target and applies its
  existing availability and authorization checks. That covers local,
  remote, and dynamic subagents. Dynamic subagents arrive as catalog deltas.
- **Durable.** Every agent call interrupts. The program parks until the
  child settles, then resumes from the ledger. Calls started together with
  `Promise.all` run concurrently.
- **Cap.** Each `execute` call can make at most 100 agent calls, the current
  `workflow()` default. Over the cap, the call fails with the existing
  `WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED` error, renamed for `execute`.
  The cap is fixed because code mode has no settings.
- **Failures are catchable.** A child failure reaches the program as a
  thrown error the program can catch.

**Signatures** are TypeScript rendered from JSON Schema, with JSDoc from the
schema descriptions. Outputs without a schema render as `Promise<unknown>`.
The instructions tell the model to narrow at runtime, or to return the raw
value and transform it in a later call.

**Budget**

- Every namespace is listed with its description and tool count.
- Full signatures are inlined up to a fixed token budget: round-robin across
  namespaces, pinned tools first.
- `search()` reaches the rest.

**Placement**

- The baseline catalog is appended as a `context.state` message on the first
  step of a session.
- Later changes append a diff of added or removed tools and changed
  signatures. They are triggered by:
  - dynamic connections resolving,
  - OAuth completing,
  - MCP `tools/list_changed`,
  - skill sets activating.
- Compaction writes a fresh baseline.
- The last announced catalog is tracked in `HistoryState`, as the skill list
  already is.
- Catalog text never enters the system prompt or a tool description. The
  system prompt's Connections section is removed, because namespace entries
  carry connection descriptions.
- When the tail message is an approval response, the delta is deferred
  instead of falling back to a system message. This also fixes the leak in
  the skill-list channel.

### Connections in `execute`

`execute` takes over every responsibility `connection_search` has today:

- **Configuration applies unchanged.**
  - `tools: { allow | block }` filters both the catalog and calls.
  - `toolCall.providedArguments` stay out of signatures and are injected at
    execution.
  - A connection's `approval` policy gates each nested call.
- **Authorization.**
  - A connection that needs sign-in before listing tools appears as a
    namespace marked "sign-in required".
  - A `search()` or call against it starts interactive authorization, which
    parks the program until sign-in completes.
  - A failed authorization marks the namespace unavailable with the error.
  - The existing check still rejects completion if the connection instance
    changed while sign-in was pending.
  - A server `401` still evicts the cached token and re-runs authorization.
- **MCP results.** Programs receive `structuredContent` when present,
  otherwise text. JSON-looking text is parsed when the tool declares no
  output schema, matching opencode.
- **OpenAPI results.** Programs receive `{ status, statusText, body }`, with
  `body` typed from the operation's success response schema.
- **State.** No per-session discovery state remains. The
  `eve.connectionSearchResults` key and the per-tool `<connection>__<tool>`
  dynamic tools are removed. The catalog is derived from the connection
  registry every step.

### Execution and durability

```text
model ── execute({ js }) ──▶ program step (QuickJS, pure)
                                │ nested call
                                ▼
                     harness tool path (validation, approval policy,
                     connection auth, tracing, protocol events)
                        │ runs now             │ must wait (approval, OAuth,
                        ▼                      ▼  subagent, durable wait)
                 result to program      interrupt ─▶ execute call parks
                                                  ─▶ resume: ledger replay,
                                                     completed calls not re-run
```

**Runtime**

- Programs run on `experimental_runCodeMode` in the app runtime, not the
  sandbox, so credentials stay app-side.
- eve owns the description and catalog rendering.

**Nested calls** take the same path as model-issued calls:

- input validation,
- approval policies,
- connection authorization,
- tracing,
- labels.

Programs receive raw JSON. `toModelOutput` applies only to what reaches the
model.

**Parking**

- Calls run inline unless they must wait for a person, a sign-in, a
  subagent, or a durable wait.
- A call that must wait interrupts, and the `execute` call parks the same way
  a tool approval does.
- On resume, the ledger skips every completed call.

**Crash semantics** match today's inline tools. A crashed step re-runs its
whole program, and the ledger protects only across interrupts. The
idempotency guidance for `defineTool` applies unchanged.

**Limits.** The AI SDK defaults become eve's defaults. Continuation signing
reuses the durable key step `workflow()` uses today
(`execution/dynamic-workflow/security-step.ts`).

### Nested calls on the protocol

- **Standard events.** Each nested call emits the standard
  `actions.requested` and `action.result` events, plus a new optional
  `parentCallId` that points to its `execute` call.
- **Qualified names.** `toolName` keeps eve's existing qualified names, such
  as `linear__list_issues`. Labels, approval and sign-in prompts, channel
  rendering, and eval `t.calledTool(...)` work unchanged.
- **Grouping.** Clients may group actions by `parentCallId`. Clients that
  ignore the field render them flat.
- **Model history.** Nested calls never enter model history. The model sees
  only the `execute` call and its result.
- **Replay.** Replay after an interrupt does not re-emit events for
  completed calls. A crashed step re-emits events under new ids, as it does
  today.

`parentCallId` is an additive public protocol change. It ships with
protocol docs and a changeset.

### Authoring API

There is no agent-level setting. Authored tools opt in individually:

```ts
export default defineTool({
  description: "Look up an order by id.",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: orderSchema, // required when codeMode is true
  codeMode: true,
  execute: async ({ id }) => getOrder(id),
});
```

- **Output schema required.** `codeMode: true` without an `outputSchema` is
  a type error, and a compile diagnostic for JavaScript authors.
- **Runtime validation.** Outputs are validated at runtime. A mismatch
  reaches the program as `InvalidToolOutput`, so the catalog never
  advertises a shape the tool doesn't return.
- **Catalog placement.** Opted-in tools join the catalog under `tools.<tool>`
  and leave the `tools` array.

### Cache invariants

Each invariant is a test target:

1. **Stable tools.** The tools array and every tool description are
   byte-identical across steps when:
   - connections are discovered, authorized, or resolved dynamically,
   - the catalog changes,
   - dynamic skills change,
   - skill sets activate.
2. **Clean system prompt.** The system prompt contains no catalog text that
   varies by session.
3. **Append-only history.** Catalog and skill-list changes only append;
   earlier messages are never rewritten.
4. **No fallback.** No announcement falls back to a system message.
5. **Deterministic rendering.** Catalog rendering is sorted and memoized per
   revision.

Two tests cover them:

- A unit test over the rendered request prefix covers all five.
- A real-model e2e eval asserts cache reuse across discovery, following
  `e2e/fixtures/agent-prompt-cache`.

## Skill sets

Activating a skill set appends two deltas:

- its tools, as `tools.<skillSet>.*`, executed remotely over MCP-style RPC;
- its skills, as unloaded skill-list entries.

The `tools` array does not change, so activation is cache-safe, and a removal
delta reverses it. Hooks, presentation, and identity forwarding belong to the
skill sets design.

## Rollout

This ships all at once, and there is no flag. Validation happens before
merge.

**Baseline.** Measure the current `connection_search` and `workflow()`
paths on `main`:

- cache read ratio per step,
- input tokens and cost per task,
- model calls per task,
- latency,
- task success.

**Build and migrate.** One release carries everything:

- `execute`, the catalog, and `search()`,
- nested approvals and authorization,
- `parentCallId`,
- OpenAPI output schemas,
- `tools.agents.*`,
- `codeMode: true` for authored tools.

It also removes `connection_search` and `workflow()`. Their docs move to
`execute`:

- `connections/overview`,
- `connections/mcp`,
- `concepts/built-in-tools`,
- `guides/dynamic-capabilities`,
- `tools/workflows`.

Their e2e fixtures move too:

- `agent-workflow-tools` and `agent-openapi-swagger` for connections,
- `agent-subagents` and `agent-cancellation` for `workflow()`.

The `agent-subagents` limit test currently uses `maxSubagents: 3`. It moves
to the fixed cap of 100.

**New evals**

- a multi-connection correlation task (Alice reconciles orders against
  payments and support tickets),
- discovery across 100+ tools,
- OAuth mid-program,
- approval mid-program,
- an MCP server with untyped outputs,
- a dynamic connection resolving mid-session,
- a program that fans out to parallel subagents and combines their outputs
  with connection data,
- cancelling a turn while subagents run inside `execute`.

**Ship gate.** Compared with the baseline, the branch must show:

- no task-success regression on connection or subagent evals,
- a clearly higher cache read ratio on discovery-heavy sessions,
- fewer model calls on composition tasks,
- no new nondeterminism in world-suite e2e runs.

If it misses the gate, it does not merge.

**Follow-up.** After ship, A/B test `Promise<Opaque>` ("return it whole or
pass it on; never read its fields") against `Promise<unknown>`. `Opaque`
becomes the default only if it reduces invented field accesses without
adding round trips or lowering task success.

## Decisions and alternatives considered

| Decision                       | Chosen                                                                 | Rejected                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Rollout                        | Ship as default, replacing `connection_search`; gated by evals         | An `experimental.codeMode` flag (root-only or per agent)                                       |
| Tool name                      | `execute`, matching opencode v2                                        | `code_mode`, `code`, `run_code`                                                                |
| Framework tools                | Always direct, as in opencode v2                                       | Code-only under code mode                                                                      |
| `workflow()`                   | Merged into `execute` as `tools.agents.*`; removed in the same release | Keeping it as a separate direct tool; a transition period with both                            |
| Agent-call cap                 | Fixed at 100 per `execute` call, the current `workflow()` default      | A configurable `maxSubagents` (code mode has no settings)                                      |
| `execute` presence             | Decided at compile time from declared connections and code-mode tools  | Always present; present only while connections are registered (flips the `tools` array)        |
| Outputs without schemas        | `Promise<unknown>`; `Opaque` tested after ship                         | Rejecting tools without schemas; `Opaque` from day one                                         |
| Skills in `search()`           | Tools only; skills move in with a future deferred-skills design        | Skill hits in `search()`; `tools.skills.load()`                                                |
| Authoring API                  | `defineTool({ codeMode: true })`                                       | `defineCodeModeTool`, a second definition kind to fold back later                              |
| Authored tools without schemas | `outputSchema` required and validated at runtime                       | Build-time TypeScript extraction (needs a type checker and adds nothing at runtime); `unknown` |
| Nested call visibility         | Protocol actions with `parentCallId`                                   | Progress only (breaks `t.calledTool` and approval correlation)                                 |
| System prompt Connections list | Removed; namespace entries carry descriptions                          | Keeping it alongside the catalog                                                               |

## Evidence limits

- **Cache hit rates are unmeasured.** No cache hit rates have been measured
  for any approach. The baseline and ship gate measure them.
- **Prior art comes from source reading.** The opencode v2 and AI SDK
  behavior is from reading source at the cited commits. None of their code
  was executed.
