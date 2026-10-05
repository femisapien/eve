---
issue: "None (follows #4300, which keeps slow bash commands running as sandbox jobs)"
status: draft
last_updated: "2026-10-05"
---

# Promote tool calls to tasks

## Summary

A tool chooses today, at definition time, whether its calls are tool calls or tasks. Some work
can't know in advance: a shell command, a test run, or an API job is usually fast and sometimes
takes twenty minutes. #4300 handled this for `bash` alone. A command still running after 30
seconds returns `status: "running"` with a pid and file paths, and the model polls and kills it
with later commands. Nothing owns that job afterwards, so `session.cancel()` leaves it running,
compaction loses its pid, and no client sees it.

This plan lets any tool start as an ordinary tool call and continue as a task when it runs long:

1. **`execute` runs inline, as today.** A call that returns settles as a normal tool result.
2. **A tool that also defines `task(handoff, ctx)` can promote a call.** When `ctx.taskSignal`
   aborts, `execute` returns `ctx.continueAsTask(handoff)`. The model gets a task receipt, and
   the `task` body continues the work durably from `handoff`.
3. **Once promoted, a call is an ordinary task.** `task_cancel`, `session.cancel()`, held turns,
   `task.result`, the `[Tasks]` note, and `task.started` / `task.settled` all apply unchanged.
4. **A handoff is never dropped.** If the turn is cancelled while `execute` runs, or before the
   step that promoted the call commits, the task still starts, already cancelled, so cleanup
   lives in one place.
5. **eve is built on eve.** The provided `bash` tool uses only this public API. Its custom
   `running` result, pid instructions, and polling advice go away.

## Authoring API

```ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { startExport, readExport, cancelExport } from "../lib/exports";

export default defineTool({
  description: "Export a report.",
  inputSchema: z.object({ reportId: z.string() }),
  async execute({ reportId }, ctx) {
    const job = await startExport(reportId, { signal: ctx.abortSignal });
    const result = await job.result({ signal: AbortSignal.any([ctx.taskSignal, ctx.abortSignal]) });
    if (result !== undefined) return result;
    return ctx.continueAsTask({ jobId: job.id }, { progress: `Exported ${job.percent}% so far.` });
  },
  async task({ jobId }, ctx) {
    "use workflow";
    return await waitForExport(jobId, ctx.abortSignal);
  },
});
```

- **`task(handoff, ctx)`** is optional on `defineTool`. It is a workflow body, so it starts with
  `"use workflow"`, receives `WorkflowToolContext`, and follows every rule of a `task()` body on
  `defineWorkflowTool`. Its return value is the call's result. It must match the tool's
  `outputSchema` and is projected by the same `toModelOutput`, so the model sees one output shape
  whether or not the call was promoted.
- **`ctx.taskSignal`** aborts when eve wants the call off the model step: 30 seconds after the
  call starts, or when a steering message arrives. It never aborts for tools without `task`.
- **`ctx.continueAsTask(handoff, options?)`** returns the value `execute` must return to promote
  the call. `handoff` must be serializable; it is the `task` body's first argument. Optional
  `progress` is model-visible text included in the receipt, such as output so far. Calling it in
  a tool without `task` throws:

  ```text
  ctx.continueAsTask() requires a task(handoff, ctx) body on tool "{toolName}".
  ```

- **Cancellation is handed off too.** When `ctx.abortSignal` aborts while `execute` holds work
  the task body could stop, `execute` returns `ctx.continueAsTask(handoff)` instead of cleaning up
  itself. eve starts the task with its `abortSignal` already aborted, and the body's cleanup runs
  in steps after the cancel, the same path as a later `task_cancel`.
- **Steps in a task body can reach the session sandbox.** `getSandbox()` on
  `WorkflowStepToolContext` attaches to the sandbox the session already uses, by reference, as a
  child session's sandbox does today. It never creates or replaces a sandbox, and throws when the
  session has none. `bash` needs this, and so does any workflow tool that works with files.

Dynamic tools from `defineDynamic` can't define `task`, as they can't define workflow bodies
today. Workflow `execute` tools and MCP tools are out of scope (see [Follow-ups](#follow-ups)).

## Observable semantics

**Inline calls don't change.** A call that settles before `ctx.taskSignal` aborts produces the
same events and result as today, and nothing marks it as a possible task.

**Promotion.** The tool call settles with a receipt that eve renders. The receipt reuses the task
receipt wording, adds `progress`, and says why the call moved:

```text
Still running after 30 seconds, so it continues as task bash-4hd8sa. Its result will arrive in a <task_result> message.
Output so far:
…
```

`task.started` follows with the call's own `callId` and `turnId`, and from then on the call is a
`task()` task: one result, `task_wait`, `task_cancel`, the 32-task limit, and a turn that can't
end while it works. The task id is `<tool>-<6 characters>`.

**Steering.** On `main`, a steering message reaches a plain tool only at the next step boundary,
so a long `bash` call holds the message for as long as it runs. With `task`, steering aborts
`ctx.taskSignal` at once, the call promotes, and the model reads the message with the task still
working. Tools without `task` keep today's behavior.

**Cancellation.**

| When the turn is cancelled                          | What happens to the work                                   |
| --------------------------------------------------- | ---------------------------------------------------------- |
| `execute` is still running                          | `execute` hands off; the task starts aborted and cleans up |
| After promotion, in the same uncommitted model step | The task started already; eve cancels it as orphaned       |
| After the promoting step committed                  | An ordinary working task; `session.cancel()` cancels it    |

Each path ends in `task.settled` with `status: "cancelled"` and `cancel.reason:
"turn_cancelled"`.

## Runtime boundary

`research/eve-tasks.md` starts a task after the model step commits its record. A promoted call
can't wait for that: its work already exists, and a cancel can discard the step. So the tool call
starts the task's run itself, and the session adopts or cancels it.

```text
model step (tool call)            session                         task run
execute ─taskSignal─▶ continueAsTask(h)
  start run keyed (session, callId) ─────────────────────────────▶ task(h, ctx)
  tool result = receipt
                     inbox: task.started(callId) ─▶ held on record
step commits ──────▶ call committed? ─ yes ─▶ working
                                      └ no ──▶ cancel ───────────▶ abortSignal aborts
```

- **Start once.** The run is keyed on the session and `callId`, so a retried step can't start a
  second run. It reports `task.started` through the session inbox, as runs report `agent.started`
  today, and the inbox outlives a discarded step.
- **Adopt or cancel.** At the step boundary the session adopts a reported task whose call the
  step committed. It cancels one whose call was discarded and emits no `task.started` for it.
  A run that reports after the boundary is matched the same way.
- **Handoffs after abort.** A cancelled turn step gives the `execute` calls it aborted a bounded
  window to return. A handoff returned in that window starts the run with `cancelled: true` in
  its start input, and the body sees an aborted `abortSignal`. A call that returns nothing in
  time keeps today's behavior.
- **Sandbox by reference.** The run's start input already carries the session's sandbox reference.
  Step attachment can resume a stopped sandbox but never writes the session's sandbox record. If
  resuming would produce a different sandbox, `getSandbox()` throws.
- **Model text** lives in `execution/tasks/render.ts`, as for every task receipt.

## The provided `bash` tool

`bash` keeps its fast path and its launcher, and moves the job's lifetime into a task body:

```ts
export default defineTool({
  description: "Execute a shell command in the shared workspace environment.",
  inputSchema: BASH_INPUT_SCHEMA,
  outputSchema: BASH_OUTPUT_SCHEMA, // { exitCode, stdout, stderr, truncated }
  async execute(input, ctx) {
    const job = await launch(await ctx.getSandbox(), input.command);
    const result = await job.result(AbortSignal.any([ctx.taskSignal, ctx.abortSignal]));
    if (result !== undefined) return result;
    return ctx.continueAsTask(job.handoff, { progress: await job.outputSoFar() });
  },
  async task(job, ctx) {
    "use workflow";
    return await watchJob(job, ctx.abortSignal); // durable waits on the exit file; kills the process group on abort
  },
});
```

- The `status: "running"` output variant and its `pid`, `outputDirectory`, and `message` fields
  are removed. `BASH_OUTPUT_SCHEMA` and `BashToolOutput` describe only the completed result. This
  is a breaking change to `eve/tools/bash`, released as `minor`.
- `kill -- -<pid>` instructions are replaced by `task_cancel`, and polling advice by
  `task.result`.
- A command the model backgrounds itself, such as `npm run dev &`, finishes the call at once and
  stays outside eve, as today. Long-lived servers should be started that way, because a promoted
  task holds the turn until it ends. The tool description says so.

## Tests

- **Integration:** a plain tool promotes on `taskSignal`, its receipt and `task.result` arrive, and
  inline calls emit nothing new. A cancel while the promoted call's parallel sibling still runs
  cancels the orphaned run. A cancel during `execute` starts the task aborted. Steering promotes
  immediately.
- **Scenario:** `bash` with a real shell promotes, reports the exit code as a task result, and
  `task_cancel` and `session.cancel()` each stop the whole process group.
- **E2E:** the sandbox fixture's `bash-background-job` eval asserts `task.started`, the task
  result, and that a cancelled turn leaves no process running.

## Open questions

- **Name of the body.** `task` matches the vocabulary and the context type. It also means "every
  call is a task" on `defineWorkflowTool`, where the same key would read differently.
- **The 30-second budget.** It starts fixed. Per-tool or per-agent settings wait for a real need.
- **Waiting in `bash`'s task body.** The session never polls, but `watchJob` must wait on a file
  in the sandbox. The options are durable sleeps with backoff, which add steps over a long run,
  or one long step blocked on `sandbox.run`, which holds compute.

## Follow-ups

- **Workflow `execute` tools** can promote without a handoff: the run already exists, and the
  session only stops waiting on it.
- **MCP tools** have no durable handle to hand off. MCP's own task support could map onto this
  later.
- **Inline-first agent calls**, which wait briefly for a reply before returning a receipt, are the
  same idea in reverse.
