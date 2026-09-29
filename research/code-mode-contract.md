---
issue: "None"
status: proposed
last_updated: "2026-09-29"
---

# Code mode contract

Code mode lets the model write a program that calls tools, instead of calling one tool per model
turn. It saves turns and context on a narrow class of tasks and costs more on the rest. This
document proposes when eve enables it, how each tool is routed to it, and what a program can rely
on when it calls authored tools and connection tools.

## Evidence

| Finding                             | Measurement                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| It pays off on deep tasks           | A synthetic incident task (two result pages, five services, four rollbacks with one retry, three notifications): model steps 13 → 2, input tokens −82.9%, wall time −51.8%, 5/5 correct in both arms |
| It loses on shallow tasks           | A data-agent task that reduced to one known SQL call: +56% wall time and +129% cost across 20 paired attempts, with 153% more output tokens                                                          |
| Models do not route adaptively      | With the same tools offered directly and through code mode, the model called code mode zero times and paid for both catalogs                                                                         |
| Program shape varies                | 51.2% of programs wrapped a single call, and open-ended prompts produced 4–8 programs per answer. One program per answer took an explicit instruction                                                |
| Untyped results fail silently       | With results typed `unknown`, programs treated `{ ok: false, retryable: true }` as success and passed 3/5; with output schemas, 5/5                                                                  |
| Models guess names before searching | With search-only discovery, 9/20 attempts were accepted against 20/20 for direct calls. In all 11 differing pairs, the model called a guessed name first                                             |
| Replay repeats writes               | When a program's step was redelivered, writes happened exactly once in 2/5 runs, against 5/5 for direct calls. Four of six compared implementations repeat a refund when a program is rerun          |
| The benefit depends on the model    | 11 of 14 models matched or beat structured calls, but GPT-4.1 fell from 98.1% to 40.4% on chained calls ([Patel et al., 2026](https://arxiv.org/abs/2608.06370))                                     |

Provider guidance agrees on routing. Anthropic recommends choosing one caller per tool "rather than
enabling both", and states that `allowed_callers` "is not a hard API-level block on direct
invocation" ([programmatic tool calling](https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling)).

Code mode is worth using when a task has several calls whose inputs depend on earlier results, no
step needs the model to read a result before continuing, the reduction to an answer can be written
in advance, the results the program branches on are typed, and every tool the task needs is
reachable from the program. The contract below keeps direct calls wherever these conditions fail.

## Authoring API

### Enablement

```ts title="agent/agent.ts"
import { defineAgent } from "eve";

export default defineAgent({
  model: "openai/gpt-5.6-terra",
  codeMode: true,
});
```

Code mode is off by default. It is enabled per agent, and the documentation lists the model
families that pass the code-mode eval suite.

### Tool routes

Every tool has exactly one route: `"code"`, `"direct"`, or `"both"`.

```ts title="agent/tools/get_order.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { orders, orderSchema } from "../lib/orders";

export default defineTool({
  description: "Look up an order by id.",
  inputSchema: z.object({ id: z.string() }),
  outputSchema: orderSchema,
  route: "direct",
  async execute({ id }) {
    return orders.get(id);
  },
});
```

When code mode is on, a tool whose call can complete inside a program defaults to `"code"`: it
leaves the model's tool list and is callable only from programs. Tools that cannot run inside a
program, such as provider-executed tools, are `"direct"` by rule rather than by omission, and the
program tool's description lists them. `"both"` is an explicit opt-in, since a tool on both routes
costs its definition twice and the model does not choose between routes reliably.

### Connection routes

```ts title="agent/connections/linear.ts"
import { defineMcpClientConnection } from "eve/connections";

export default defineMcpClientConnection({
  url: "https://mcp.linear.app/mcp",
  description: "Linear issues, projects, and comments.",
  route: "code",
  routes: { create_issue: "direct" },
});
```

`route` sets the default for every tool the connection serves, after `tools.allow` and
`tools.block` apply. `routes` overrides it by tool name; a name the server does not publish is a
definition warning. OpenAPI connections take the same options. MCP annotations such as
`readOnlyHint` never set a route, because the specification treats them as untrusted unless the
server is trusted.

## Observable semantics

### What the model sees

- One program tool, `code_mode`, present whenever code mode is on, whichever connections are
  resolved.
- A budgeted listing of code-route tools: names and TypeScript signatures, grouped by connection
  under the connection's `description`. Tools beyond the budget are listed by name, and their
  schemas are available through `describe`.
- Direct-route tools as ordinary model tools.

### Inside the program

- Authored tools are `tools.<name>(input)`. Connection tools are `tools.<connection>.<tool>(input)`,
  with both names derived from the file path and the server's tool name.
- `search(query)` and `describe(names)` cover authored and connection tools. A tool found by
  `search` is callable in the same program, with no model turn in between.
- Calling a name that does not exist throws an error listing the closest names.
- Input signatures keep schema constraints such as `minimum`, `maximum`, and `pattern`.
- A declared `outputSchema` becomes the result type. An authored tool without one returns
  `unknown`. An MCP tool with `outputSchema` returns its `structuredContent`; without one, it
  returns the typed `{ content }` envelope from the MCP result. An OpenAPI operation returns its
  documented response schema when the document describes one.

### Validation and errors

- Inputs are validated against the tool's schema at the bridge. Values that are not JSON, such as
  `Date`, `BigInt`, and functions, are rejected with an error instead of being converted.
- Results are validated when a schema exists. A failure throws with the field, the constraint, and
  a preview of the value. `tools.<name>.raw(input)` returns the unvalidated result.
- A tool error is rethrown in the program with its name, message, and data intact. An MCP result
  with `isError: true` throws with the result's text, so a failed call cannot be read as a value.

### Approval, authorization, and replay

- A nested call that needs approval or connection authorization pauses the program at that call.
  The approval shows the concrete arguments. On resume, a replayed call whose arguments differ
  from the approved ones is refused.
- Each nested call is its own durable step. Its id is assigned when the call is made, in program
  order, not when it completes. A replay returns the recorded result or the recorded error instead
  of calling the tool again.
- Per-call durability is a prerequisite for shipping code mode. Without it, every write before a
  crash repeats when the program's step is retried.

```text
model ── code_mode({ js }) ──▶ program
                                 │ tools.x(input)
                                 ▼
               validate input ──▶ durable step (id in program order) ──▶ execute / tools/call
                                                                              │
               typed result or thrown error ◀── validate output ◀────────────┘
```

### Execution limits

- The wall-clock budget excludes time spent waiting on tools. Every remote call has its own
  timeout.
- Recorded values have a size cap. Exceeding it throws an error that tells the program to return a
  smaller value or a reference.
- When a program returns or times out, in-flight calls are cancelled through their abort signal.
- Reads may run concurrently. Calls to tools not known to be read-only run one at a time.

### Output and runtime

- The model receives only the program's return value, with a size cap. A truncated result says
  that it was truncated.
- Programs receive raw tool results. `toModelOutput` applies only to direct calls.
- Each program runs in a fresh context with no state carried from earlier programs. The runtime is
  standard JavaScript, and the program tool's description lists every difference.

### Tracing and evaluation

- Each nested call emits the same action events as a direct call, with the program's call id as
  its parent, and its usage is attributed to that call.
- Evaluations of code-mode agents report programs per answer and the share of single-call
  programs, alongside success, tokens, cost, and latency.

## Verification

Fixture evals cover the golden paths: a deep task where code mode must reduce model steps and input
tokens without losing correctness, and a single-call control where the regression is reported.
Other evals cover a connection tool found and called in one program, approval and sign-in inside a
program, an MCP result with `isError: true`, and an MCP tool without `outputSchema`.

A scenario test kills the process mid-program on a task with writes and checks that no write
repeats. Another replays an approved call with changed arguments and checks that it is refused.
Unit tests cover route defaults and overrides, non-JSON input rejection, and output validation.

## Open questions

- Whether eve enforces the model-family list or only documents it.
- How a tool declares that it is read-only for concurrency, given that MCP annotations are
  untrusted.
- Whether `"both"` should exist at all, pending an eval that offers both routes on tasks that do
  and do not fit code mode.
