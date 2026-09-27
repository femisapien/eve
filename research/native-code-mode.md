---
issue: TBD
status: proposed
last_updated: "2026-09-27"
---

# Native code mode

## Summary

eve gives the model one code tool, `execute`. The model writes a short
JavaScript program that calls connections and opted-in tools through a typed
`tools` object, and composes their results. Those capabilities never enter
the provider `tools` array, so adding, discovering, or activating them never
breaks the prompt cache.

- One flag, `experimental: { codeMode: true }`, turns on the whole feature.
  Connections and framework tools route through `execute`, and
  `connection_search` is removed. Today every successful search breaks the
  whole cached prefix.
- The tool catalog is delivered as append-only conversation messages. The
  `execute` description never changes.
- Nested calls go through the existing harness tool path: approvals,
  connection auth, tracing, and protocol events. Calls that must wait for a
  person or a sign-in park the program durably and resume from a replay
  ledger.
- Authored tools opt in with `defineTool({ codeMode: true })` and must
  declare an `outputSchema`. Tools eve does not control, such as MCP servers
  without output schemas, are typed `unknown` rather than rejected.
- Making code mode the default depends on measured cache reuse, model
  calls, and task success.

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
- **Output types are available.** Composition needs known output types. eve's
  own tools, MCP output schemas, and OpenAPI response schemas provide them.

## Current state

**Any tool change invalidates the full cache.** `prepareModelTools`
(`harness/tool-loop.ts`) rebuilds the `ToolSet` every step. Providers
render tools before the system prompt and messages, so any change to the
`tools` array invalidates the entire cached prefix. eve places Anthropic
breakpoints on the last tool, the system prompt, and the conversation tail
(`harness/prompt-cache.ts`); none of them survive a tool change.

**`connection_search` busts the cache on every hit.**
(`execution/tools/connection-search.ts`)

- Each discovered tool is added to the `tools` array on the next step as
  `<connection>__<tool>`, which invalidates the cached prefix.
- Each schema is paid for twice: once in the search result, once in the tool
  definition.
- Matching is naive token overlap.
- A tool cannot be discovered and called in the same step.

**The append-only channel leaks.** Dynamic skill changes are appended as
framework `context.state` user messages (`harness/current-messages.ts`). When
the tail message is an approval response, the text falls back to a system
message, which breaks the cache.

**Pieces to build on**

- **The `workflow` tool already runs durable code mode.** It runs
  model-written JavaScript in QuickJS as a pure step. Each `ctx.agent()` call
  becomes an interrupt, and the program resumes from a signed continuation.
  The signing key is created in a durable step
  (`execution/dynamic-workflow/`).
- **Most framework tools declare an `outputSchema`.** `web_search` is the
  exception.
- **MCP connections forward the server's `outputSchema` when one exists.**
- **OpenAPI connections declare no output schema.** They return
  `{ status, statusText, body }` untyped, even when the spec describes the
  response.

## Prior art

Sources:

- opencode v2: branch `v2` at
  [`c0d49f1`](https://github.com/sst/opencode/tree/c0d49f101c3079f4fb3f08af4026fb5cb0873745).
  The `dev` branch is v1.
- `@ai-sdk/code-mode`: `vercel/ai` at `5d12eaa`, 1.0.75. It has the same API
  as eve's 1.0.62. See the [docs](https://ai-sdk.dev/docs/ai-sdk-core/code-mode).

|                   | opencode v2                                        | AI SDK code mode                                      | eve (proposed)                                        |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------- |
| Model surface     | `execute` plus direct tools                        | one code tool, routed by `experimental_toolCallers`   | `execute` plus direct tools                           |
| Routed into code  | all MCP tools by default; opt-out per server       | tools whose callers include code mode                 | connections, framework tools, opted-in authored tools |
| Runtime           | in-process acorn AST interpreter                   | QuickJS in worker threads (`run`)                     | AI SDK runtime                                        |
| Catalog placement | session baseline plus appended deltas              | tool description (default) or appended full catalog   | appended baseline plus deltas                         |
| Discovery         | budgeted inline listing plus `search()` in program | full declarations; `toolSearch()` outside the program | budgeted listing plus `search()` in program           |
| Unknown outputs   | `Promise<unknown>`                                 | `Promise<unknown>`                                    | `Promise<unknown>`, with `Opaque` A/B                 |
| Nested approvals  | same permission path as direct calls               | callback, or signed interrupt (undocumented)          | harness approval path; parks durably                  |
| Limits            | none set by core                                   | 30 s, 64 MB, 256 calls, 1 MB result                   | AI SDK defaults                                       |
| Nested visibility | progress on the parent call                        | none                                                  | protocol actions with `parentCallId`                  |

**opencode v2**

- **Tool split.** `core/src/tool.ts` keeps read, edit, write, patch, shell,
  glob, grep, webfetch, websearch, question, skill, and subagent as direct
  tools. Everything else is reachable only through `execute`.
- **Invariant description.** The `execute` description contains runtime rules
  only.
- **Catalog.** `codemode/catalog.ts` lists every namespace with its tool
  count, then inlines signatures round-robin up to about 2,000 tokens. The
  model reaches the rest through a synchronous `search()`.
- **Catalog updates.** Changes append as deltas (`session/instruction-state.ts`),
  and the baseline resets only at compaction. On AI SDK provider routes,
  deltas become escaped `<system-update>` user messages
  (`ai/src/protocols/shared.ts`), the same shape as eve's `context.state`.
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
- **Cache behavior of the defaults.** The default discovery mode,
  `"description"`, embeds the catalog in the tool description and breaks the
  cache on any change. Local `toolSearch()` adds discovered tools to the
  `tools` array (`ai/src/tool-search/prepare-tool-search.ts`), which breaks
  the cache the same way `connection_search` does.

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

1. **Code mode is a routing decision, not a mode.** Both implementations pair
   one code tool with a small direct set. Each capability is reachable exactly
   one way, which satisfies "no multiple modes" from the model's side.
2. **Catalog placement, not code mode itself, protects the cache.** Three
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

- The description is fixed per eve version. It states the runtime rules and
  never names a tool, connection, or skill.
- `execute` is a reserved tool name while code mode is enabled.
- Docs call it "the code mode `execute` tool" to distinguish it from a tool
  definition's `execute` function.

**Program globals**

- `tools.<namespace>.<name>(input)`
- A synchronous `search({ query?, namespace?, limit?, offset? })` over tools.
- `console`
- No `fetch`, filesystem, timers, or imports. HTTP and files go through tools
  that enforce eve's authorization, SSRF, and sandbox policies.

**Result**

- The model receives the JSON return value, captured logs, and a summary of
  nested calls.
- Errors are returned as data with suggestions, such as "Did you mean
  `tools.linear.list_issues`?".

**Direct tools**

- **Direct tools stay limited to control-plane actions:** `load_skill`,
  subagent tools, `ask_question`, `task_cancel`, and the final output tool.
- **Framework tools become code-only:** `bash`, `read_file`, `write_file`,
  `glob`, `grep`, `web_fetch`, and `web_search`. `web_search` gains an
  `outputSchema` first, because every tool eve owns must declare its output.
- No tool is reachable both directly and from code.

**Skills** keep their listing and `load_skill`. Skill-list updates follow the
same append-only rule as the catalog. With code mode on, `load_skill`'s
connection hint points to `search({ namespace })` instead of
`connection_search`.

### Catalog

**Namespaces**

Namespaces derive from file paths, and collisions are compile errors.

| Source              | Path                                                        |
| ------------------- | ----------------------------------------------------------- |
| Connection tools    | `tools.<connection>.<tool>`                                 |
| Framework tools     | `tools.<tool>`, for example `tools.bash`                    |
| Opted-in authored   | `tools.<tool>`                                              |
| Extension tools     | `tools.<extension>.<tool>`                                  |
| Subagents (Phase 2) | `tools.agents.<name>({ message, agentId?, outputSchema? })` |

**Subagent calls**

- A subagent call resolves to the child's output, validated against
  `outputSchema` when one is given.
- It always interrupts. The program resumes when the child settles.
- Existing availability and authorization checks apply.
- There is a cap of 100 agent calls per program.
- `agents` is a reserved namespace.

**Signatures** are TypeScript rendered from JSON Schema, with JSDoc from the
schema descriptions. Outputs without a schema render as `Promise<unknown>`.
The instructions tell the model to narrow at runtime, or to return the raw
value and transform it in a later call.

**Budget**

- Every namespace is listed with its tool count.
- Full signatures are inlined up to a fixed token budget: round-robin across
  namespaces, pinned tools first.
- `search()` reaches the rest.

**Placement**

- The baseline catalog is appended as a `context.state` message on the first
  step where code mode is available.
- Later changes append a diff of added or removed tools and changed
  signatures. They are triggered by:
  - dynamic connections resolving,
  - OAuth completing,
  - MCP `tools/list_changed`,
  - skill sets activating.
- Compaction writes a fresh baseline.
- Catalog text never enters the system prompt or a tool description.
- When the tail message is an approval response, the delta is deferred
  instead of falling back to a system message. This also fixes the leak in
  the skill-list channel.

**Sign-in required.** Connections that need sign-in before they can list
tools appear as marked namespaces. A `search()` or call against one starts
the normal authorization flow.

### Execution and durability

```text
model ── execute({ js }) ──▶ program step (QuickJS, pure)
                                │ nested call
                                ▼
                     harness tool path (validation, approval policy,
                     connection auth, tracing, protocol events)
                        │ runs now             │ must wait (approval,
                        ▼                      ▼  OAuth, durable wait)
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

- Calls run inline unless they must wait for a person, a sign-in, or a
  durable wait.
- A call that must wait interrupts, and the `execute` call parks the same way
  a tool approval does.
- On resume, the ledger skips every completed call.

**Crash semantics** match today's inline tools. A crashed step re-runs its
whole program, and the ledger protects only across interrupts. The
idempotency guidance for `defineTool` applies unchanged.

**Limits.** The AI SDK defaults become eve's defaults, and authors can raise
them. Continuation signing reuses the `workflow` tool's durable key step.

### Nested calls on the protocol

**Standard events.** Each nested call emits the standard `actions.requested`
and `action.result` events, plus a new optional `parentCallId` that points to
its `execute` call.

**Qualified names.** `toolName` uses eve's existing qualified names, such as
`linear__list_issues`. Because of that, these work unchanged:

- labels,
- approval and sign-in prompts (`input.requested`,
  `authorization.required`),
- channel rendering,
- eval `t.calledTool(...)`.

**Client and model views**

- Clients may group actions by `parentCallId`. Clients that ignore the field
  render them flat.
- Nested calls never enter model history. The model sees only the `execute`
  call and its result.

**Replay behavior**

- Replay after an interrupt does not re-emit events for completed calls.
- A crashed step re-emits events under new ids, as it does today.

`parentCallId` is an additive public protocol change. It ships with
protocol docs and a changeset.

### Authoring API (experimental)

```ts title="agent/agent.ts"
export default defineAgent({
  experimental: {
    codeMode: true,
  },
});
```

**Enabling code mode**

This one flag enables everything in this document. There are no other code
mode settings.

- **Root-only, and applies to the whole agent tree.** The flag is set only
  on the root `agent.ts`, and it applies to the root and every local
  subagent. Each agent in the tree still has its own `execute` tool and its
  own catalog.
  - Setting it in a subagent's `agent.ts` is a compile error, following the
    existing `experimental.workflow.world` rule:

    ```text
    Code mode configuration is only supported on the root agent config.
    Remove "experimental.codeMode" from "<agentId>".
    ```

  - Remote subagents are separate deployments. Their own root decides.
- In every agent in the tree:
  - Connections and framework tools route only through `execute`.
  - `connection_search` is removed.
- Enabling code mode is a compile error while any agent in the tree uses
  `workflow()`, until `tools.agents.*` ships. After that, `workflow()` and
  `eve/tools/workflow` are removed, a breaking change we accept pre-1.0.

**Authored tools** opt in individually:

```ts
export default defineTool({
  description: "Look up an order by id.",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: orderSchema, // required when codeMode is true
  codeMode: true,
  execute: async ({ id }) => getOrder(id),
});
```

**Output schema requirement**

- `codeMode: true` without an `outputSchema` is a type error, and a compile
  diagnostic for JavaScript authors.
- Outputs are validated at runtime. A mismatch reaches the program as
  `InvalidToolOutput`, so the catalog never advertises a shape the tool
  doesn't return.

**Without the root flag**

The tool-level `codeMode: true` only declares where a tool goes when code mode
is on. Without the root flag:

- The tool is an ordinary direct tool, and `outputSchema` is still required.
- `eve build` and `eve dev` warn about each tool in the agent's own directory
  that sets `codeMode: true`, naming the tool and the missing
  `experimental.codeMode`.
- Extension tools produce no warning. That lets an extension ship code-mode
  tools that also work in agents without code mode.
- When code mode becomes the default, these tools move into `execute` with no
  author change.

**OpenAPI connections** derive `outputSchema` from each operation's success
response schema. `body` becomes typed. This is the cheapest large gain in
composability.

### Cache invariants

Each invariant is a test target:

1. **Stable tools.** The tools array and every tool description are
   byte-identical across steps when:
   - connections are discovered or authorized,
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

**Phase 0: baseline.** Measure the current `connection_search` path:

- cache read ratio per step,
- input tokens and cost per task,
- model calls per task,
- latency,
- task success.

**Phase 1: connections and framework tools.**

- Ship `experimental.codeMode` with:
  - the catalog and `search()`,
  - nested approvals and auth,
  - protocol events,
  - code-only framework tools,
  - OpenAPI output schemas.
- Evals:
  - a multi-connection correlation task (Alice reconciles orders against
    payments and support tickets),
  - discovery across 100+ tools,
  - OAuth mid-program,
  - approval mid-program,
  - an MCP server with untyped outputs,
  - a sandbox task that reads, edits, and runs files through `tools.*`.

**Phase 2: authored tools and agents.**

- Ship `codeMode: true` for authored tools.
- Ship `tools.agents.*`, port the `workflow()` fixtures, then remove
  `workflow()`.
- A/B test `Promise<Opaque>` ("return it whole or pass it on; never read its
  fields") against `Promise<unknown>`. `Opaque` becomes the default only if it
  reduces invented field accesses without adding round trips or lowering task
  success.

**Phase 3: defaults.** Code mode becomes the default when Phase 1 shows:

- no task-success regression on connection or sandbox evals,
- a clearly higher cache read ratio on discovery-heavy sessions,
- fewer model calls on composition tasks,
- no new nondeterminism in world-suite e2e runs.

Otherwise it stays opt-in, and `connection_search` is fixed separately.

## Decisions and alternatives considered

| Decision                                    | Chosen                                                                   | Rejected                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Tool name                                   | `execute`, matching opencode v2                                          | `code_mode`, `code`, `run_code`                                                                |
| Outputs without schemas                     | `Promise<unknown>`; `Opaque` tested in Phase 2                           | Rejecting tools without schemas; `Opaque` from day one                                         |
| `workflow()`                                | Merged into `execute` as `tools.agents.*`; mutually exclusive until then | Keeping both tools; letting them coexist during the experiment                                 |
| Configuration                               | One flag, `experimental: { codeMode: true }`                             | Per-feature knobs such as a separate `frameworkTools` switch                                   |
| Flag scope                                  | Root-only; applies to the whole local agent tree                         | Per agent (like `workflow.modelCallsPerStep`); per agent with inheritance                      |
| Tool `codeMode: true` without the root flag | Ordinary direct tool; build and dev warn for the agent's own tools       | Compile error (blocks extension tools); silent fallback                                        |
| Framework tools                             | Code-only when code mode is on; control-plane tools stay direct          | Keeping sandbox and web tools direct, as opencode v2 does                                      |
| Skills in `search()`                        | Tools only; skills move in with a future deferred-skills design          | Skill hits in `search()`; `tools.skills.load()`                                                |
| Authoring API                               | `defineTool({ codeMode: true })`                                         | `defineCodeModeTool`, a second definition kind to fold back later                              |
| Authored tools without schemas              | `outputSchema` required and validated at runtime                         | Build-time TypeScript extraction (needs a type checker and adds nothing at runtime); `unknown` |
| Nested call visibility                      | Protocol actions with `parentCallId`                                     | Progress only (breaks `t.calledTool` and approval correlation)                                 |

## Evidence limits

- **Cache hit rates are unmeasured.** No cache hit rates have been measured
  for any approach. Phases 0 and 1 measure them, and the Phase 3 criteria act
  on the results.
- **Prior art comes from source reading.** The opencode v2 and AI SDK
  behavior is from reading source at the cited commits. None of their code
  was executed.
