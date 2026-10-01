---
issue: TBD
status: proposed
last_updated: "2026-10-01"
---

# Tool stubs for evals

## Summary

An eval can choose a stub set for the sessions it starts. A stub set replaces
what named tools return. The model still sees each real tool's name,
description, input schema, and approval policy, and still decides on its own
whether to call it. Only the tool's `execute` changes.

Stub sets are code in `evals/stubs/`. They keep per-session state, so a stubbed
`create_issue` followed by a stubbed `list_issues` stays consistent. eve
compiles them only into the local server that `eve eval` starts, so a deployed
agent never contains stub code.

## Problem

An eval that exercises a real tool needs that tool's credentials, network
access, and live data, and its side effects really happen. Agents work around
this today in three ways:

- **Evals that avoid tools.** They assert decisions that come before a tool
  runs, such as a pending approval, or they call library functions directly.
  The model never reads a tool result.
- **Results pasted into the prompt.** The eval tells the agent not to call
  tools and supplies the data as text. The model never sees the data as a
  tool result, and the eval cannot check that the tool was called.
- **External runners.** A separate benchmark runner starts a fake MCP server
  per task in Docker and wires it to the agent's tool names. This works, but
  it needs Docker and its own runner, and it does not run under `eve eval`.

An app cannot build this cleanly on top of eve. Replacing a tool with a
same-named dynamic tool means copying its description, schema, and approval by
hand, and those copies drift from the real tool. The eval client has no
model-invisible field for the server, so apps carry stub data in custom headers
and channel code.

## Authoring API

A stub set is one file. Its name comes from the file path, and its tool names
are the keys of `tools`.

```ts title="evals/stubs/two-workflows.ts"
import { defineToolStubs } from "eve/evals";

export default defineToolStubs({
  state: () => ({
    schedules: [{ id: "sched_1", name: "Weekly commit activity", cron: "0 17 * * 4" }],
  }),
  tools: {
    schedules_read: (input, { state }) => ({
      action: "read",
      schedules: state.schedules,
    }),
    schedules_create: (input, { state }) => {
      const schedule = { id: `sched_${state.schedules.length + 1}`, ...input };
      state.schedules.push(schedule);
      return { action: "create", schedule };
    },
  },
});
```

An eval selects the set when it starts a session:

```ts title="evals/schedules.eval.ts"
import { defineEval } from "eve/evals";

export default defineEval({
  async test(t) {
    const turn = await t.send("What workflows do I have?", { stubs: "two-workflows" });
    t.calledTool("schedules_read");
    turn.messageIncludes("Weekly commit activity");
  },
});
```

`t.session({ stubs })` accepts the same option. Later messages and approval
responses in that session use the set without repeating it.

A stub receives the tool input and a context with `state`, `toolName`, and
the session fields an authored tool's `ctx` already has. It returns the same
shape as the real `execute`. `state()` returns the starting state for each
session and must be JSON-serializable.

## Semantics

```text
eve eval
  ├─ compiles agent/ and evals/stubs/ into the local server
  └─ starts it with EVE_EVALUATION=1

t.send(message, { stubs: "two-workflows" })
  └─ session create carries `stubs`
       └─ eve channel accepts it only when EVE_EVALUATION=1,
          stores the set name and state() with the session

model calls schedules_read
  └─ approval policy                       (unchanged)
       └─ before execute: session has a stub set?
            ├─ stub for this tool     → run the stub
            ├─ no stub for this tool  → fail the turn (authored and connection tools)
            └─ no stub set            → run the real tool
       └─ toModelOutput, durable history   (unchanged)
```

- **Only the local eval server accepts stubs.** It is the server `eve eval`
  starts, which already runs with `EVE_EVALUATION=1`. A session create with
  `stubs` anywhere else fails with an error that names the cause, including
  under `eve eval --url`. This covers local runs and CI jobs that run
  `eve eval`.
- **Approval runs first.** A stub replaces `execute`, so approval policies,
  pending approval cards, and denials behave as they do in production. A denied
  call never reaches the stub.
- **Results take the real path.** A stub's return value goes through the same
  normalization and `toModelOutput` as a real result and lands in durable
  session history. Resuming a parked turn does not run the stub again.
- **State is durable session data.** eve saves it with the session after each
  step, so it survives approval pauses, later turns, and retries.
- **Missing stubs fail closed.** In a stubbed session, an authored or
  connection tool without a stub fails the turn with an error that names the
  set and the tool. Its real `execute` does not run. eve's built-in tools,
  such as `ask_question`, `load_skill`, and `todo`, run as usual.
- **Unknown sets fail at session create.** The error lists the sets eve found
  in `evals/stubs/`.
- **Subagents inherit the set.** A child session uses the parent's stub set
  and starts from the parent's state at the moment it starts.
- **The model sees nothing.** `stubs` is never sent to the model, and the
  real tool definitions are unchanged.

## Scope

In scope: authored tools in `agent/tools/`, dynamic tools, and connection
tools.

Out of scope for this proposal:

- workflow tools and agent tools, which run outside the model step;
- provider-executed tools, such as a provider's built-in web search;
- deployed targets reached with `eve eval --url`;
- matching rules on tool arguments, and recording real results for replay.
  A stub is a function, so it can branch on its input.

## Prior art

- **Interceptors in the agent process.** LangChain's `wrap_tool_call`,
  Mastra's `beforeToolCall`, Google ADK's `before_tool_callback`, Semantic
  Kernel's function filters, and Microsoft Agent Framework's
  `FunctionMiddleware` let test code return a result in place of running the
  tool. They rely on the test building the agent in-process.
- **Temporal mock Activities.** Tests register fake Activities under the real
  names on a separate worker and route the run to it. The fake code lives with
  the worker, the run selects it, and results enter durable history. This is
  the model for stub sets.
- **Mock MCP servers.** Fake servers hold a simulated world behind related
  tools. `state` plays that role here.

## Alternatives

- **Fixed results sent with the request.** The eval passes
  `{ toolName: result }` and eve returns it. It needs no new discovery, but it
  cannot keep state or react to input, and large results such as images must
  travel in the request.
- **Network-level mocks.** Intercepting `fetch` fakes the services a tool
  calls. It cannot reach clients built on `node:http` or raw sockets, and the
  eval author writes upstream API responses.

## Open questions

- **Typed stub inputs.** Can `defineToolStubs` type each stub's `input` from
  the real tool's input schema?
- **State across subagents.** Should a child's state changes flow back to the
  parent, or is a snapshot at child start enough?
- **Built-in tools that reach the network.** Should `web_fetch` and
  `web_search` fail closed in a stubbed session, or stay available?
- **Observability.** Should `action.result` events and traces mark a stubbed
  call?
