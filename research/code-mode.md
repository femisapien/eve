---
issue: "TBD (no matching issue found)"
status: proposed
last_updated: "2026-09-29"
---

# Code mode

Code mode lets the model write a program that calls tools, instead of calling one tool per model
turn. eve already runs model-written programs through `workflow()`, but they can only call
`ctx.agent`. This document proposes a `code_mode` tool that supersedes `workflow()` and can call the
agent's tools, including connection tools.

- `code_mode` runs on the sandbox and parking bridge that `workflow()` uses today, keeps
  `ctx.agent`, and adds `ctx.tools`, `ctx.search`, and `ctx.describe`. `workflow()` and
  `connection_search` are removed.
- Each tool has one route, `"direct"` or `"code"`. Authored tools default to direct; connection
  tools default to code.
- Nested calls go through the ordinary harness tool path, so approvals, sign-in, validation, and
  events behave as they do for direct calls. Replay is per nested call.
- The model's tool list and the `code_mode` description stay fixed for the session, so discovery
  never invalidates the prompt cache.

The design follows from two bodies of evidence: measurements of when code mode's premises hold, and
a comparison of six code-mode implementations across 22 design dimensions.

## Premises

Code mode is argued for on seven claims. Each holds on some tasks and fails on others.

| Claim                               | Holds when                                        | Fails when                                                                                             |
| ----------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Fewer turns, lower latency and cost | Several dependent calls; fan-out; expensive turns | One-call tasks; programs that wrap a single call; long generated programs; steps that need judgment    |
| Smaller context                     | Large intermediate results with a known reduction | Exploratory questions; answers that must cite data; programs that return everything; silent truncation |
| Affordable large catalogs           | Hundreds to thousands of tools                    | Catalogs of 128 tools or fewer; guessed names; discovery that costs turns                              |
| More reliable than structured calls | Recent frontier models; typed results             | Older or smaller models; unusual runtimes; untyped results                                             |
| Exact data passing                  | Correct programs; lossless serialization          | Wrong programs; values changed in transit; models skipping the tools                                   |
| Data kept from the model            | Tight bindings; no network; per-call approval     | Weak sandboxes; prompt injection with a way out; whole-program approval                                |
| Reusable state                      | Not demonstrated                                  | Restarts; stateless hosted runtimes                                                                    |

The measurements behind the table:

| Finding                             | Measurement                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| It pays off on deep tasks           | A synthetic incident task (two result pages, five services, four rollbacks with one retry, three notifications): model steps 13 → 2, input tokens −82.9%, wall time −51.8%, 5/5 correct in both arms |
| It loses on shallow tasks           | A data-agent task that reduced to one known SQL call: +56% wall time and +129% cost across 20 paired attempts, with 153% more output tokens                                                          |
| The harness decides the direction   | The same incident task without durable steps took 7 direct steps; code mode cut them to 2 but ran 35.4% slower, because output rose from 1,027 to 2,607 tokens                                       |
| Models do not route adaptively      | With the same tools offered directly and through code mode, the model called code mode zero times and paid for both catalogs                                                                         |
| Program shape varies                | 51.2% of programs wrapped a single call, and open-ended prompts produced 4–8 programs per answer. One program per answer took an explicit instruction                                                |
| Untyped results fail silently       | With results typed `unknown`, programs treated `{ ok: false, retryable: true }` as success and passed 3/5; with output schemas, 5/5                                                                  |
| Searching in a model turn is slow   | Searching for tools in one model turn and calling them in the next added 127% wall time and 73.8% cost on one task                                                                                   |
| Models guess names before searching | With search-only discovery, 9/20 attempts were accepted against 20/20 for direct calls. In all 11 differing pairs, the model called a guessed name first                                             |
| The replay unit matters             | A prototype that ran a whole program inside one step repeated its writes on redelivery: exactly-once in 2/5 runs, against 5/5 for direct calls                                                       |
| The benefit depends on the model    | 11 of 14 models matched or beat structured calls, but GPT-4.1 fell from 98.1% to 40.4% on chained calls ([Patel et al., 2026](https://arxiv.org/abs/2608.06370))                                     |

Code mode is therefore worth using for a task when all of these hold:

1. several calls take inputs from earlier results;
2. every tool the task needs is reachable from the program;
3. no step needs the model to read a result before continuing;
4. the reduction from results to an answer can be written in advance;
5. the results the program branches on have declared types;
6. the task is read-only, or its writes tolerate the same replay rules as direct calls;
7. the model has been evaluated on this runtime.

The design keeps direct calls wherever these conditions fail, and the evaluation plan tests the ones
the evidence does not settle.

## Method

The six implementations were compared by reading source at pinned revisions and running local probes
against the same toy order tools, such as `get_order` and `refund_order`, on 2026-09-26:

- OpenCode 2 at
  [`278db30`](https://github.com/sst/opencode/tree/278db3023f5de390984ca4e1b68db264944e0caf);
- Executor at
  [`5e67950`](https://github.com/UsefulSoftwareCo/executor/tree/5e67950afdb20ff0fa0e716211f5825fb1580162);
- Cloudflare Agents at
  [`c076e4c`](https://github.com/cloudflare/agents/tree/c076e4c9ff6cfb72931085226edfd3ee7965ac48),
  both its simple `createCodeTool` wrapper and its durable runtime;
- Codex `rust-v0.157.1`
  ([`3665039`](https://github.com/openai/codex/tree/36650394c5b38c2990ccf2a3457165ca3e9d9726)),
  probed through its binary;
- Amp / Orbs, from its documentation only.

Each implementation was classified on 22 dimensions in six groups: setup, discovery, execution,
output, recovery, and operations. The benchmark numbers above come from internal benchmarks; task
details are omitted here.

## Current state

- **Programs.** `workflow()` from `eve/tools/workflow`, enabled by `agent/tools/workflow.ts`, takes
  `{ js }` and runs it in the vendored `@ai-sdk/code-mode` QuickJS sandbox as a side-effect-free
  step. It runs each call as a task, so the program's value reaches the model later, in a
  `task.result` message. Its only host binding is `ctx.agent`, capped by `maxSubagents`. Each call
  parks the program as an interrupt; the owning durable workflow runs the pending batch, then
  resumes the program from its signed continuation. A failed resolution reaches the program as a
  thrown error that carries only a message.
- **Direct tools.** A `defineTool` call runs inline in the step that holds the model call. A
  completed step replays from its record; a step interrupted mid-execution re-runs, tool calls
  included. Approval requests carry the exact tool input.
- **Connections.** `connection_search` stores its results in durable session context, and matched
  tools become callable in the model's next response, so every discovery costs a turn. Each hit adds
  tools to the model's tool list. Tool definitions come first in the cached prompt, and changing
  them invalidates the whole cache ([Anthropic prompt
  caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Search results
  carry each tool's input and output schema, which the tool definition then repeats. MCP tool names
  are fetched lazily on first use. OpenAPI connections filter by `operationId` through `operations`.
  Dynamic connections resolve from `session.started` or `turn.started`.
- **Projections.** `toModelOutput` controls what the model sees of a result. MCP results are
  projected to their content blocks, without `_meta` or `structuredContent`, and failures get a
  leading "Tool call failed:" marker.
- **Events.** `action.started` has no parent field, and action spans are parented to the
  model-attempt span.

## Authoring API

### The code-mode tool

```ts title="agent/tools/code_mode.ts"
import { codeMode } from "eve/tools/code-mode";

export default codeMode({ maxSubagents: 20 });
```

`code_mode` supersedes `workflow()`. It keeps the `{ js }` input, `ctx.agent`, and `maxSubagents`,
and adds `ctx.tools`, `ctx.search`, and `ctx.describe`. `workflow()` and `eve/tools/workflow` are
removed in the same release, so the model never sees two JavaScript tools. Authored durable tools,
defined with `defineWorkflowTool`, are unaffected.

An agent has `code_mode` when it defines `agent/tools/code_mode.ts` or any connection under
`agent/connections/`; an agent with connections and no file gets the defaults. There is no separate
flag, and an agent with neither is unchanged. The documentation lists the model families that pass
the code-mode eval suite.

Unlike `workflow()`, `code_mode` does not run as a task. The call blocks the turn until the program
returns, and the program's value is the tool result, because the model's next step depends on it.
While the program waits on a nested call, the turn parks durably without holding compute.

### Tool routes

```ts title="agent/tools/get_order.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { orders, orderSchema } from "../lib/orders";

export default defineTool({
  description: "Look up an order by id.",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: orderSchema,
  route: "code",
  async execute({ id }) {
    return orders.get(id);
  },
});
```

A tool's route is `"direct"` (the default) or `"code"`. A `"code"` tool leaves the model's tool list
and is callable only as `ctx.tools.<name>(input)` from `code_mode` programs. No route exposes a tool
both ways. `route: "code"` is a definition error when the agent has no `code_mode` tool, when the
tool defines `toModelOutput`, when it has no `execute`, as with provider-executed tools, or when it
is itself a workflow tool.

### Connection routes

```ts title="agent/connections/linear.ts"
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description: "Linear issues, projects, and comments.",
  routes: { create_issue: "direct" },
});
```

A connection's tools default to `"code"`. `route` changes the default for every tool the connection
exposes after its filter, `tools.allow` or `tools.block` for MCP and `operations` for OpenAPI.
`routes` overrides it per tool, keyed by MCP tool name or OpenAPI `operationId`. MCP tool names are
known only once the connection lists its tools, so a `routes` key the server does not publish is a
runtime warning, logged when the connection's tools are first fetched.

A `"direct"` connection tool is in the model's tool list from the start of the session, with no
search; eve fetches that connection's tools when the session starts. Only static connections and
`session.started` connections can route a tool `"direct"`. `turn.started` connections are code-only,
so the tool list never changes during a session.

## Design by dimension

Each dimension lists what the six implementations do, what eve does, and why.

### Setup

#### Tool registration

- **Observed.** Tools come from the host's registry (OpenCode 2's agent registry, Cloudflare's host
  toolset or connectors, Codex's turn registry), from saved integrations (Executor), or from MCP
  configuration (OpenCode 2, Codex, Amp).
- **eve.** No new registry. Authored tools come from `agent/tools/` and extensions, and connection
  tools from `agent/connections/`, with names derived from paths and server tool names. Routes
  decide which tools the program can call.
- **Why.** eve's registries already carry schemas, approval policies, and authorization. Code mode
  needs a route, not a second catalog.

#### Calling routes

- **Observed.** The host chooses per tool (OpenCode 2's `options.codemode`), per session
  (Executor's `codemode` or `passthrough` mode; Codex's tool mode), or by which tools it also lists
  directly (Cloudflare). Amp routes by where an MCP server is configured: saved remote servers are
  code-only, and local ones are direct. Codex's `code_mode` mode exposes nested tools both ways; its
  `code_mode_only` mode does not.
- **eve.** One route per tool, `"direct"` or `"code"`, set on the definition or on the connection.
  Authored tools default to direct and connection tools to code. No route exposes a tool both ways.
- **Why.** Offered both routes, the model never picked code mode. Anthropic advises choosing one
  caller per tool "rather than enabling both", and its `allowed_callers` "is not a hard API-level
  block on direct invocation" ([programmatic tool
  calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)).
  A route is enforced only by exposure.

#### Initial tool context

- **Observed.** Selected definitions within a budget (OpenCode 2 lists whole signatures within
  about 2,000 tokens; Codex lists non-deferred tools), namespace names only (Executor, Cloudflare
  durable), every definition (Cloudflare simple), or instructions only (Amp). Codex's
  `code_mode_only` omits deferred MCP tools entirely, even by name.
- **eve.** The `code_mode` description holds the runtime rules, signatures of code-route authored
  tools up to a token budget, names for the rest, and static connections by name and description. It
  is fixed for the session.
- **Why.** Search-only discovery led models to guess names (9/20). Selection accuracy barely
  changes up to 128 tools, and most eve agents have tens, so listing signatures is affordable. A
  description that changed mid-session would invalidate the prompt cache.

#### Definition format

- **Observed.** Every implementation that shows nested tools renders TypeScript declarations from
  JSON Schema, inside plain-text instructions. JSON Schema appears only for direct tools and
  passthrough search.
- **eve.** TypeScript declarations rendered from input and output schemas. Constraints such as
  `minimum`, `maximum`, and `pattern` are kept as comments. `code_mode` itself is a JSON Schema tool
  with a `js` string.
- **Why.** Generated TypeScript that dropped a Zod maximum led the model to send `30` where the
  maximum was `25`.

### Discovery

#### Discovery interface

- **Observed.** An in-code API (OpenCode 2's `search`, Executor's `tools.search`, Cloudflare
  durable's `codemode.search`, Codex's `ALL_TOOLS`), a direct model tool (Amp's `tool_search`,
  Executor's passthrough mode, Codex's `code_mode` mode), or none (Cloudflare simple).
- **eve.** `ctx.search(query)` and `ctx.describe(names)` inside the program, over code-route
  authored tools and connection tools. There is no model-facing search tool; `connection_search` is
  removed.
- **Why.** Search as its own model turn cost 127% more wall time on one task, and
  `connection_search` adds tools to the tool list on every hit, which invalidates the cache.
  In-program search costs neither.

#### Search ranking

- **Observed.** Every implementation with search ranks lexically, with weighted fields (path, name,
  description, namespace). Codex's `code_mode_only` sorts `ALL_TOOLS` by name and leaves filtering
  to the model; its direct `tool_search` uses BM25.
- **eve.** Lexical matching over tool names, descriptions, and connection descriptions, reusing the
  existing connection matching. A search with no match says so, and calling an unknown name throws
  with the closest names.
- **Why.** No implementation or measurement shows that semantic ranking helps at eve's catalog
  sizes. A missed synonym looks the same as a missing tool, so the failure must name what exists.
  Discovery misses are measured separately from execution errors (H3).

#### Search timing

- **Observed.** Every implementation with in-code search lets a program find and call a tool in the
  same execution.
- **eve.** A tool found by `ctx.search` is callable in the same program.
- **Why.** A benchmark arm passed with two searches inside one program. Today's `connection_search`
  makes a found tool callable only in the next response.

### Execution

#### Generated language

- **Observed.** JavaScript everywhere. OpenCode 2 and Executor strip TypeScript without type
  checking. Codex takes raw JavaScript through a grammar-constrained tool instead of a JSON string.
- **eve.** A JavaScript async function body in `{ js }`, as `workflow()` takes today.
- **Why.** Every implementation converged on JavaScript. Grammar-constrained input is an open
  question.

#### Execution runtime

- **Observed.** A confined interpreter (OpenCode 2), QuickJS (Executor self-hosted), Worker
  isolates (Cloudflare, Executor cloud), a local V8 isolate (Codex), or a browser iframe
  (Cloudflare). Each removes different globals: OpenCode 2 has no timers or `globalThis`, and Codex
  deletes `console`, `WebAssembly`, `SharedArrayBuffer`, and `Atomics`.
- **eve.** The vendored `@ai-sdk/code-mode` QuickJS sandbox, run as a side-effect-free step as
  today. It has no network, imports, filesystem, or process; host capabilities are only `ctx.agent`
  and `ctx.tools`. The description lists every difference from standard JavaScript.
- **Why.** The sandbox is already vendored and works with durable parking. Each unlisted difference
  is a way for a program to fail.

#### Input validation and transport

- **Observed.** OpenCode 2 validates every nested call. Executor and Cloudflare depend on the
  adapter, and Codex does not validate: MCP servers get raw arguments. JSON transport changed values
  without errors: a `Date` became a string, `undefined` was dropped, and a `BigInt` threw or never
  settled.
- **eve.** Every nested call is validated against the tool's input schema, as a direct call is.
  Values that are not JSON are rejected with an error instead of being converted.
- **Why.** A silent conversion produces a wrong call that nothing reports.

#### Authorization and approvals

- **Observed.** Per-call checks with an approval pause (OpenCode 2, Executor, Codex, Cloudflare
  durable), approval-gated tools excluded (Cloudflare simple), or host policy only (Amp). Gaps sit
  outside the bridge: OpenCode 2's `fetch` skips the permission hooks.
- **eve.** Every nested call goes through the ordinary harness tool path: approval policies,
  connection authorization, and sign-in. A call that needs approval uses the existing approval
  request, which carries the exact input, and the turn parks as it does for a direct call. A
  declined call throws in the program. The program has no route to the network except tools.
- **Why.** Approving a whole program approves arguments that are not yet known. Because the program
  resumes from its signed continuation, it cannot change a call's input after the call is made.

#### Parallelism and cancellation

- **Observed.** Most runtimes overlap calls under `Promise.all`; Amp does not document it. Codex
  overlaps only tools marked parallel-safe (`readOnlyHint` or server support) and serializes the
  rest. Cloudflare durable numbers calls on arrival, and a run that paused after `Promise.all`
  failed replay with a divergence. Executor and Cloudflare simple kept running calls after a
  timeout; one refund landed about 200 ms after the timeout was reported.
- **eve.** Pending agent calls fan out, as they do today. Pending tool calls run one at a time, in
  program order. Cancelling the turn aborts the in-flight call, and calls a program leaves
  un-awaited are cancelled when it returns.
- **Why.** Serializing tool calls keeps replay deterministic and writes ordered. Concurrent reads
  need a trusted read-only declaration, and MCP annotations are untrusted.

#### Execution budgets

- **Observed.** Wall-clock timeouts (60 s on Cloudflare; 5 minutes on Executor, suspended while
  waiting on tools), output caps (30,000 characters on Executor, 10,000 tokens on Codex), a
  1,000,000-byte cap per recorded value (Cloudflare durable), and configurable call-count caps that
  OpenCode 2 leaves unset.
- **eve.** The existing bridge request limit (256) counts tool calls as well as agent calls, and
  `maxSubagents` still counts only agent calls. The time budget covers sandbox execution; waiting on
  a call parks instead of counting. Every remote connection call has a timeout. Recorded values have
  a size cap whose error tells the program to return a smaller value or a reference.
- **Why.** A budget that stops the program but not its calls leaves effects landing after the model
  was told the program stopped.

#### State and context lifetime

- **Observed.** Every implementation starts each execution with fresh variables. Live process state
  (OpenCode 2, Executor, Codex's `store()`) did not survive a restart; Cloudflare durable keeps
  durable call records.
- **eve.** A fresh context per program, with no state carried across programs. Within one program,
  progress survives restarts through the signed continuation. The catalog is fixed for the session.
- **Why.** No source measured a benefit from reusable state, and the state that exists did not
  survive restarts.

### Output

#### Return-type information

- **Observed.** A declared schema with an `unknown` fallback everywhere. Executor adds observed
  shapes marked as possibly incomplete. Codex types MCP results as `CallToolResult`, with
  `structuredContent` typed by the output schema.
- **eve.** A declared `outputSchema` becomes the result type, and an authored tool without one
  returns `unknown`. An MCP tool with `outputSchema` returns its `structuredContent`; without one,
  it returns `{ content }`, the content blocks the model projection shows. OpenAPI results use the
  documented response schema when there is one, and `unknown` otherwise.
- **Why.** Untyped results passed 3/5 and typed ones 5/5. A declared type is only useful if it is
  honest, so eve does not infer types from observed results.

#### Output validation

- **Observed.** Only Amp validates results, throwing with the field, the constraint, and a preview;
  it offers a `.raw()` escape hatch. The others pass invalid results through: a declared string
  `status` arrived as `123`, and a program skipped a refund without any error.
- **eve.** Results are validated when a schema exists, and a failure throws with the field, the
  constraint, and a preview. There is no raw escape hatch; a tool that cannot promise a shape omits
  `outputSchema`.
- **Why.** A program reads fields it has not seen, so an unchecked type becomes silently wrong
  control flow.

#### Output delivered to the model

- **Observed.** The return value plus logs (OpenCode 2, Executor, Cloudflare), explicit emissions
  only (Codex), and host transforms; output caps can truncate without saying so.
- **eve.** The model receives the program's JSON return value, up to a size cap, and a truncated
  result says that it was truncated. Tools with `toModelOutput` cannot be code-route, since a
  program could return the raw result and bypass the projection.
- **Why.** The return value is the reduction the program was written to produce. A silent cut
  changes the answer.

### Recovery

#### Tool-error delivery

- **Observed.** Thrown exceptions (OpenCode 2, Cloudflare), error values for expected failures
  (Executor's `{ ok: false }`, Codex's `CallToolResult` with `isError`), or both (Amp throws on
  `isError` unless `.raw()` is used). Codex rejects handler errors with a plain string, so
  `e.message` is undefined.
- **eve.** A failed call always throws in the program, with the tool error's name and message. An
  MCP result with `isError: true` throws with its text, and a declined approval throws.
- **Why.** An error returned as a value can be read as success, which is the untyped-result failure.

#### Repair policy

- **Observed.** Source normalization of fences and function wrappers (Executor, Cloudflare),
  diagnostics returned to the model (all), and one targeted retry after a refreshed sign-in
  (Executor). OpenCode 2 drops the diagnostic kind before the model sees it.
- **eve.** Fences and function wrappers are normalized deterministically. Failures return typed
  diagnostics: unknown tools with the closest names, invalid arguments with their issues, and
  reference errors with the available globals. Nothing is retried automatically.
- **Why.** A failed program costs a full turn, so the diagnostic has to be enough to fix it in one.

#### Continuation

- **Observed.** A new execution (OpenCode 2, Cloudflare simple), resuming a suspended execution in
  memory (Executor, Codex), or replaying recorded calls (Cloudflare durable).
- **eve.** The program resumes from its signed continuation with recorded resolutions, as
  `workflow()` does today, across restarts. After a program fails, the model writes a new one.
- **Why.** In-memory suspension did not survive a restart in Codex or Executor.

#### Repeated effects and compensation

- **Observed.** Mostly host responsibility. Rerunning a refund program refunded twice in OpenCode
  2, Codex, and Executor (on resubmission), and Amp documents that it "may issue two refunds".
  Cloudflare durable replays recorded results and supports explicit rollback, but re-runs calls that
  were executing or threw.
- **eve.** Nested calls get the same guarantee as direct calls. A completed call is recorded before
  the program resumes, and replay returns the record. A call interrupted mid-execution re-runs, so a
  non-idempotent tool needs the same idempotency or approval it needs as a direct call. eve provides
  no compensation.
- **Why.** A whole-program replay unit repeated writes in 3 of 5 runs. A per-call unit matches what
  direct calls already guarantee.

### Operations

#### Tracing and attribution

- **Observed.** Parent call ids (OpenCode 2, Cloudflare durable), nested spans (Executor, Codex), a
  durable audit log (Cloudflare durable), or none (Cloudflare simple). Codex's nested call items
  carry fresh ids with no link to the program.
- **eve.** Action events gain `parentCallId`, which is the `code_mode` call id for a nested call.
  The nested action span is a child of the `code_mode` action span, and usage is attributed per
  call.
- **Why.** Approvals, logs, and evals need to see nested calls as the same actions as direct calls.

## Migration

One release removes `workflow()` and `connection_search`.

- **`workflow()`.** Agents rename `agent/tools/workflow.ts` to `agent/tools/code_mode.ts` and
  export `codeMode()` with the same options. Programs that call `ctx.agent` keep working, and their
  value now arrives as the tool result instead of a `task.result` message. A file that still imports
  `eve/tools/workflow` fails the build with an error that names `codeMode()`. The `agent-subagents`
  and `agent-cancellation` fixtures move to `code_mode`.
- **`connection_search`.** It and the `<connection>__<tool>` model tools are removed. The
  `agent-workflow-tools` and `agent-openapi-swagger` fixtures and their connection evals move to
  `ctx.search` and `ctx.tools`.

The affected docs are `concepts/built-in-tools`, `connections/overview`, `connections/mcp`,
`guides/dynamic-capabilities`, and `tools/workflows`, whose runtime-generated workflow section
becomes a code mode page.

## Verification

A unit test over the rendered model request checks that the tool list and the `code_mode`
description do not change when a program finds a connection tool or a `turn.started` connection
resolves. Unit tests also cover route defaults and definition errors, signature rendering, non-JSON
input rejection, output validation, and error mapping.

Scenario tests extend the existing program-step coverage. A nested tool call parks and resumes. A
process killed after a nested call completes resumes without re-running it. A nested call that needs
approval is approved in one run and declined in another.

Fixture evals cover a deep composition task and a single-call control, a connection tool found with
`ctx.search` and called in the same program, sign-in in the middle of a program, an MCP tool without
`outputSchema`, a program that fans out to subagents and combines their replies with tool results,
and cancelling a turn while subagents run inside `code_mode`.

## Evaluation plan

| ID  | Question                                                   | Test                                                                                                           | Decision rule                                                                      |
| --- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| H1  | Do gains require several dependent calls?                  | Task-shape suite with a single-call control; k ≥ 20                                                            | Revise the conditions unless code mode loses on the control and wins on deep tasks |
| H2  | Which results need declared types?                         | The same tasks with no output schemas, schemas only on results the program branches on, and schemas everywhere | Require types only where their absence measurably lowers correctness               |
| H3  | Does the budgeted listing beat search alone?               | A catalog with 150+ distractor tools                                                                           | Keep the listing if it reduces guessed names without raising cost                  |
| H4  | Does per-call replay prevent duplicate writes?             | Kill the process mid-program on a task with writes                                                             | Zero duplicates of completed calls at k ≥ 20                                       |
| H5  | Does approval inside a program work end to end?            | A refund that needs approval: accept, decline, and replay                                                      | No write before approval, and none repeated after                                  |
| H6  | Does the benefit hold across eve's model providers?        | The same suite across providers                                                                                | The documented model-family list                                                   |
| H7  | Does hiding intermediate results hurt exploratory answers? | Real-prompt suite with expected answers                                                                        | Recommend direct routes for exploratory tools if quality drops                     |
| H8  | Could a tool usefully be exposed both ways?                | Exclusive routes against both routes, on fitting and non-fitting tasks                                         | Add a dual route only if the model picks correctly at an agreed rate               |

Every eval of an agent with code-route tools reports programs per answer and the share of
single-call programs, alongside success, tokens, cost, and latency.

## Evidence limits

- Most local runs are n = 1 to k = 5, and several vendor figures are self-reported without a setup.
- Amp was classified from documentation only; 10 of its 22 cells are unknown.
- Cache hit rates were not measured; the cache argument rests on provider documentation.

## Open questions

- Whether eve enforces the model-family list or only documents it.
- How a tool declares that it is read-only, so that reads can run concurrently.
- Whether `code_mode` takes raw JavaScript through grammar-constrained tools where the provider
  supports them.
- Whether console output reaches the model when a program fails.
