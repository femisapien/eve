---
issue: "TBD (no matching issue found)"
status: proposed
last_updated: "2026-09-29"
---

# Code mode contract

Code mode lets the model write a program that calls tools, instead of calling one tool per model
turn. It saves turns and context on a narrow class of tasks and costs more on the rest. eve already
runs model-written programs through the `workflow()` tool, whose only host binding is
`ctx.agent`. This document proposes letting those programs call the agent's tools, replacing
`connection_search` with discovery inside the program, and fixes which tools a program can call and
what it can rely on when it does.

## Evidence

| Finding                             | Measurement                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| It pays off on deep tasks           | A synthetic incident task (two result pages, five services, four rollbacks with one retry, three notifications): model steps 13 → 2, input tokens −82.9%, wall time −51.8%, 5/5 correct in both arms |
| It loses on shallow tasks           | A data-agent task that reduced to one known SQL call: +56% wall time and +129% cost across 20 paired attempts, with 153% more output tokens                                                          |
| Models do not route adaptively      | With the same tools offered directly and through code mode, the model called code mode zero times and paid for both catalogs                                                                         |
| Program shape varies                | 51.2% of programs wrapped a single call, and open-ended prompts produced 4–8 programs per answer. One program per answer took an explicit instruction                                                |
| Untyped results fail silently       | With results typed `unknown`, programs treated `{ ok: false, retryable: true }` as success and passed 3/5; with output schemas, 5/5                                                                  |
| Search as a model turn costs a turn | On one task, searching for tools in a model turn and calling them in the next added 127% wall time and 73.8% cost against direct calls                                                               |
| Models guess names before searching | With search-only discovery, 9/20 attempts were accepted against 20/20 for direct calls. In all 11 differing pairs, the model called a guessed name first                                             |
| The replay unit matters             | A prototype that ran a whole program inside one step repeated its writes on redelivery: exactly-once in 2/5 runs, against 5/5 for direct calls                                                       |
| The benefit depends on the model    | 11 of 14 models matched or beat structured calls, but GPT-4.1 fell from 98.1% to 40.4% on chained calls ([Patel et al., 2026](https://arxiv.org/abs/2608.06370))                                     |

Anthropic recommends choosing one caller per tool "rather than enabling both", and states that
`allowed_callers` "is not a hard API-level block on direct invocation"
([programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)).

Code mode is worth using when a task has several calls whose inputs depend on earlier results, no
step needs the model to read a result before continuing, the reduction to an answer can be written
in advance, the results the program branches on are typed, and every tool the task needs is
reachable from the program. The contract keeps direct calls wherever these conditions fail.

## Current state

- **Programs.** `workflow()` (`agent/tools/workflow.ts`) is a workflow tool that takes `{ js }` and
  runs it in the vendored `@ai-sdk/code-mode` QuickJS sandbox. The sandbox runs as a side-effect-free
  step. Each `ctx.agent` call parks the program as an interrupt. The owning durable workflow runs the
  pending calls, then resumes the program from its signed continuation with their resolutions
  (`execution/dynamic-workflow/`). A failed resolution reaches the program as a thrown error that
  carries only a message.
- **Direct tools.** A `defineTool` call runs inline in the step that holds the model call. A
  completed step replays from its record; a step interrupted mid-execution re-runs, tool calls
  included. Approval requests carry the exact tool input.
- **Connections.** `connection_search` stores its results in durable session context, and matched
  tools become callable in the model's next response, so every discovery costs a turn. Each hit adds
  tools to the model's tool list. Tool definitions come first in the cached prompt, and
  changing them invalidates the whole cache
  ([Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
  Search results carry each tool's input and output schema, which the tool definition then repeats.
  MCP tool names are fetched lazily on first use. OpenAPI connections filter by `operationId`
  through `operations`. Dynamic connections resolve from `session.started` or `turn.started`.
- **Projections.** `toModelOutput` controls what the model sees of a result. MCP results are
  projected to their content blocks, without `_meta` or `structuredContent`, and failures get a
  leading "Tool call failed:" marker.
- **Events.** `action.started` has no parent field, and action spans are parented to the
  model-attempt span.

## Authoring API

### Enablement

Code mode is the existing `workflow` tool. An agent has it when it defines
`agent/tools/workflow.ts` or any connection under `agent/connections/`; there is no separate flag.
An agent with connections but no `workflow.ts` gets `workflow()` with its defaults. An agent with
neither is unchanged.
The documentation lists the model families that pass the code-mode eval suite.

### Tool routes

A tool's route is `"direct"` (the default) or `"code"`.

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

A `"code"` tool leaves the model's tool list and is callable only as `ctx.tools.<name>(input)` from
`workflow` programs. There is no route that exposes a tool both ways. `route: "code"` is a
definition error when:

- the agent has no `workflow` tool;
- the tool defines `toModelOutput`, since a program could return the raw result and bypass the
  projection;
- the tool has no `execute`, as with provider-executed tools;
- the tool is itself a workflow tool.

### Connection routes

```ts title="agent/connections/linear.ts"
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description: "Linear issues, projects, and comments.",
  routes: { create_issue: "direct" },
});
```

A connection's tools default to `"code"`, since programs are where connection tools are found.
`route` applies to every tool the connection exposes after its filter: `tools.allow` or
`tools.block` for MCP, and `operations` for OpenAPI. `routes` overrides it per tool, keyed by MCP
tool name or OpenAPI `operationId`. MCP tool names are known only once the connection lists its
tools, so a `routes` key the server does not publish is a runtime warning, logged when the
connection's tools are first fetched. MCP annotations such as `readOnlyHint` never set a route.

A `"direct"` connection tool is in the model's tool list from the start of the session, with no
search; eve fetches that connection's tools when the session starts. Only static connections and `session.started` connections can route a tool `"direct"`;
`turn.started` connections are code-only, so the tool list never changes during a session.

## Observable semantics

### What the model sees

- `connection_search` is removed. Code-route tools do not appear in the model's tool list, and
  connection tools are found only from programs.
- The tool list and the `workflow` description are fixed for the session. Finding a tool or
  resolving a `turn.started` connection never changes them.
- The `workflow` description lists code-route authored tools with TypeScript signatures, up to a
  token budget; tools beyond the budget are listed by name. Static code-route connections are listed by
  name and `description`. Dynamic connections are found with `ctx.search`.

### Inside the program

- `ctx.agent` is unchanged. Code-route tools are `ctx.tools.<name>(input)`, and connection tools
  are `ctx.tools.<connection>.<tool>(input)`.
- `ctx.search(query)` and `ctx.describe(names)` cover code-route tools, connection tools included.
  They reuse the existing connection resolution and matching, and their results are recorded as
  program resolutions rather than in session context.
  A tool found by `ctx.search` is callable in the same program.
- Calling a name that does not exist throws an error that lists the closest names. For a
  connection, these are the tools the server actually publishes.
- Signatures keep input constraints such as `minimum`, `maximum`, and `pattern`. A declared
  `outputSchema` becomes the result type, and an authored tool without one returns `unknown`.
- An MCP tool with `outputSchema` returns its `structuredContent`. Without one, it returns
  `{ content }`, the same content blocks the model projection shows. OpenAPI results use the
  operation's documented response schema when the document has one, and `unknown` otherwise.

### Calls, approval, and replay

- A nested tool call parks the program the way `ctx.agent` does. The owning workflow runs the call
  through the ordinary harness tool path, including input validation, approval, connection
  authorization, and instrumentation, then resumes the program with the result.
- Nested calls run one at a time, in program order.
- A call that needs approval uses the existing approval request, which carries the exact input, and
  the turn parks as it does for a direct call. A declined call reaches the program as a thrown
  error. Because the program resumes from its signed continuation, it cannot change a call's input
  after the call is made.
- Nested calls get the same replay guarantee as direct calls. A completed call is recorded before
  the program resumes, and replay returns the record. A call interrupted mid-execution re-runs, so
  a non-idempotent tool needs the same idempotency or approval it needs as a direct call. The
  replay unit is one nested call, not the whole program.

### Validation and errors

- Inputs are validated against the tool's schema before the call. Values that are not JSON, such
  as `Date`, `BigInt`, and functions, are rejected with an error instead of being converted.
- Results are validated when a schema exists. A failure throws with the field, the constraint, and
  a preview of the value.
- A failed resolution carries the tool error's name and message. An MCP result with
  `isError: true` resolves as failed with the result's text, so a failed call cannot be read as a
  value.

### Limits and output

- The existing bridge request limit counts tool calls as well as agent calls. `maxSubagents` still
  counts only agent calls.
- Every remote connection call has a timeout, as the MCP specification recommends.
- Cancelling the turn aborts the in-flight nested call and stops the program.
- The model receives the program's JSON return value, up to a size cap. A truncated result says
  that it was truncated.
- Each program runs in a fresh context, and the `workflow` description lists every difference from
  standard JavaScript.

### Tracing and evaluation

- Action events gain `parentCallId`. For a nested call it is the `workflow` call's id, and the
  nested action span is a child of the `workflow` action span instead of the model-attempt span.
- Evaluations of agents with code-route tools report programs per answer and the share of
  single-call programs, alongside success, tokens, cost, and latency.

## Migration

`connection_search` and the `<connection>__<tool>` model tools are removed in the same release.
Connection docs move to programs: `concepts/built-in-tools`, `connections/overview`,
`connections/mcp`, `guides/dynamic-capabilities`, and `tools/workflows`. The
`agent-workflow-tools` and `agent-openapi-swagger` fixtures and their connection evals move to
`ctx.search` and `ctx.tools`.

## Verification

A unit test over the rendered model request checks that the tool list and the `workflow`
description do not change when a program finds a connection tool or a `turn.started` connection
resolves. Unit tests also cover route defaults and definition errors, signature rendering, non-JSON input
rejection, output validation, and the mapping of MCP `isError` results.

Scenario tests extend the existing program-step coverage. A nested tool call parks and resumes. A
process killed after a nested call completes resumes without re-running it. A nested call that
needs approval is approved in one run and declined in another.

Fixture evals cover a deep composition task, where code-route tools must reduce model steps and
input tokens without losing correctness, and a single-call control, where the regression is
reported. Other evals cover a connection tool found with `ctx.search` and called in the same
program, sign-in in the middle of a program, and an MCP tool without `outputSchema`.

## Open questions

- Whether eve enforces the model-family list or only documents it.
- How a tool declares that it is read-only, so that reads can run concurrently. MCP annotations are
  untrusted, so they cannot be the declaration.
- Whether `workflow` is still the right model-facing name once programs call tools.
