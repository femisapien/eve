---
issue: "None (follows closed PR #3982; no matching issue found)"
status: proposed
last_updated: "2026-09-29"
---

# Owning-step event dispatch

## Summary

A session event has two parts: the write to the session stream, and the
dispatch to its channel adapter handler and stream-event hooks. On main the
session emitter does both in one call. Dispatch can change session state through
`defineState`, sandbox access, and adapter state, and only the step that owns
session state can keep those changes. One event breaks this rule. An
`agent.started` that arrives while a model step runs is dispatched outside the
owning step, so its hooks' state writes are dropped. `docs/guides/hooks.md` therefore tells authors to use `agent.started`
hooks only to observe.

This plan splits write from dispatch for every event under one rule:

- An event is written to the stream when it happens.
- Dispatch runs only inside a step that owns session state. Events a step
  produces are dispatched in that step, as today.
- An event written while another step owns state becomes a _pending dispatch_.
  The next state-owning step runs pending dispatches before its own events.

In the common case this adds no durable step. There is no public API change.
`agent.started` becomes the first user of the pending path, and no dispatch code
names it.

## Current behavior

The session workflow body threads one state pair through its steps with
`SessionStateCursor`. Each state-owning step goes through `cursor.advance` and
returns a delta from the state it was given, through `withSessionStateDelta`.
The cursor applies the delta to that same base. If the state changed while the
step ran, the cursor throws. It treats this as a sequencing bug and never
merges. So each session has one writer at a time.

Most events already follow the rule:

- The turn step dispatches `step.*`, `action.*`, `turn.*`, and message events
  inline through `createTurnEventHandler`. Hooks can call `ctx.cancel()` there.
- Messages from other workflow runs, such as task replies, `ctx.report()`
  updates, questions, and withdrawals, wait in the session inbox. The turn
  admits them at the next boundary and applies each one in its own
  state-owning step, such as `applyTaskRunMessageStep` or
  `emitWorkflowToolRunReportStep`. Their hooks' state writes are kept, and each
  message costs one durable step.
- An `agent.started` that arrives during a blocking wait, a held turn, or
  between turns takes the same path through `emitAgentStartedStep`, and its
  hooks' state writes are kept.

The exception is `StepAgentStarts.publishWhile`. Clients follow a child session
from `agent.started`, and the remote-agent stream proxy binds a remote child by
finding that event in the parent stream. A model step can run for a long time.
So while `turnStep` runs, eve publishes each arriving `agent.started` in a
separate `emitAgentStartedStep` and never adopts that step's result. The event,
its adapter handler, and its hooks all run against a copy of state that is then
discarded. No built-in channel adapter handles `agent.started`. An authored
adapter may, and its adapter-state changes are discarded the same way.

## Proposed semantics

```text
workflow body (cursor)                 durable steps
────────────────────────────           ──────────────────────────────────────
advance(turnStep N) ─────────────────▶ turnStep N
                                         own events: write, then dispatch
  run message arrives mid-step
  └─ write step ─────────────────────▶ write agent.started (no dispatch)
     pending += stamped event
adopt delta N
advance(next step, pending) ─────────▶ next state-owning step
                                         1. dispatch pending, in write order
                                         2. own events: write, then dispatch
adopt delta; pending = []
about to wait, hand off, or end?
  pending non-empty ─────────────────▶ dispatch-only step
```

### Where pending dispatches run

| After the step that was running                                                    | Pending dispatches run in                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------ |
| Next model step, coordination dispatch, task message, steering route, cancel       | That step, before its own events                 |
| Turn parks, is held on tasks, waits on runtime results, or session waits for input | One dispatch-only step before the body waits     |
| Session completes or fails                                                         | One dispatch-only step before the terminal event |
| Handoff to a successor run                                                         | None pending. Handoff happens only after a wait  |

The invariant: pending dispatches are empty whenever the workflow body waits
for input, hands off, or ends. Hook latency is therefore bounded by the next
boundary and never by the next user message.

### Durability and replay

The write step returns the stamped event, so pending dispatches come from
durable step results, and workflow replay rebuilds them. The cursor passes them
in the next step's input and clears them only when it adopts that step's
result.

A retried step runs its pending dispatches again with the same event and
`meta.id`. The failed attempt's state is discarded with it, so each dispatch's
state writes land in committed session state exactly once. Handler invocation
and external side effects stay at-least-once, which matches the contract in
`docs/guides/hooks.md`. Exactly-once handler execution is not achievable for
in-step events today, and this plan does not promise it. A retried write step
can still write the event twice, as documented today. Only the attempt that
completes becomes pending, so the event is dispatched once.

### Ordering

- Every event is dispatched after it is written. This is unchanged.
- Events one step produces are dispatched in stream order within that step.
  This is unchanged.
- Pending events are dispatched in write order, before any event of the step
  that runs them.
- A pending event is dispatched after the hooks of every event the running step
  wrote after it. If a child opens during the model step that ends the turn, a
  `*` hook sees `turn.completed` and `session.waiting` before `agent.started`.

Hook order is stream order per producing step, not global stream order. This
matches #3982 and is inherent to single-writer dispatch, because the only other
option is to delay dispatch of in-step events. Consumers that need global order
sort by `meta.id`.

### Hook and channel context

- A pending dispatch sees session state as committed when the next step starts.
  That state can include changes from the step that was running when the event
  was written.
- `ctx.cancel()` from a pending dispatch is ignored with the existing "not part
  of a running turn" warning. The turn the event arrived during has already
  reached its boundary. Boundary publications behave this way today.
- For a pending event, the channel adapter handler and activity-state update
  run with the hooks, after the write. For in-step events, the documented order
  stays: adapter handler, stamp, write, hooks. eve ignores adapter handler
  return values, so a handler for a pending event loses only one ability: it can
  no longer mutate the event's data before the write. The outbound activity
  projection also moves with dispatch, because it reads the activity state that
  dispatch updates. Both are no-ops for `agent.started` today.

### Failure paths

- A retried step behaves as described in
  [Durability and replay](#durability-and-replay).
- If a step fails the session, finalization runs pending dispatches in one
  dispatch-only step before `session.failed`. They run against the last
  committed state. Their state writes don't matter because the session ends,
  but external side effects, such as a `*` audit hook, still run. That matches
  in-step events, whose hooks ran during the failed attempt. A failure in this
  step is logged and does not block the terminal event.
- If a turn is cancelled, `settleCancelledTurnStep` owns state, so pending
  dispatches run there.

### What stays the same

For events produced inside a state-owning step, nothing changes. Dispatch
timing, `ctx.cancel()` eligibility, memory lifecycle, dynamic model, tool,
skill, and instruction preparation, instrumentation, and the documented emit
order are all unchanged. `agent.started` is still written to the stream as soon
as it arrives.

## Cost

Costs are durable steps for each `agent.started` that arrives while a model step
runs. No latency was measured for this plan.

| Scenario                 | Extra durable steps                                             | Critical-path effect                                                 |
| ------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| main                     | 1 write-and-dispatch step beside the model step                 | Overlaps the model step. Hook state is dropped                       |
| #3982, subscribed        | Main's step, plus 1 dispatch step per model step that wrote one | +1 sequential durable step before the next boundary                  |
| Proposal, subscribed     | Main's step, plus 0 when a state-owning step follows, 1 if not  | The hooks' own duration in the next step. See the dispatch-only step |
| Proposal, not subscribed | Main's step only. Nothing becomes pending                       | Same as main                                                         |

On main and in the proposal, adoption of the model step's result waits for any
write step still in flight. A subscriber is an adapter handler for the event
type, a typed hook, or a `*` hook. `*` persisters are common, so the subscribed
case is the realistic one.

The dispatch-only step runs after the turn's terminal events and after any
delegated-caller notification, so it does not delay the turn that a client or
parent sees. Input that arrives during the step waits until the step ends.
Before a terminal event, the step delays `session.completed` or
`session.failed` by one durable step.

## Scope of the change

The change stays in the session workflow layer and the emitter. It does not
touch the harness or tool loop.

- The emitter exposes the write and the dispatch as two named operations. Its
  combined emit for in-step events is those two in the documented order. No
  optional writable stands in for "already written."
- The cursor already sequences every state-owning step, so it also owns pending
  dispatches. On the step side, the shared `withSessionStateDelta` wrapper is
  where they run before the step's own work.
- The mid-step write keeps its own step, because the workflow body cannot write
  the stream directly.

The inbox still decides which run messages are written during a model step.
That is a stream-latency policy, not a dispatch rule. A message qualifies only
when producing its event requires no session state change. `agent.started`
qualifies. `task.settled` does not, because it is produced by the task-table
update that it reports.

## Alternatives considered

- **Special-case `agent.started` (#3982, rejected).** This PR wrote the event
  mid-step with no dispatch, then ran its adapter handler and hooks in a new
  `publishWrittenEventsStep` after the model step's result was applied. To mark
  "already written," it made `sessionWritable` optional on the emitter, and
  review flagged that as a smell. It cost one sequential durable step for each
  model step that wrote a subscribed `agent.started`. Its first revision also
  skipped the deferred hooks when the model step failed. It was closed in favor
  of a structural fix, because one event needed its own dispatch path. This plan reaches the same
  hook semantics through a rule that applies to every event, and it removes the
  extra step in the common case.
- **Merge concurrent state deltas.** Merging would give up single-writer state
  and require conflict rules for arbitrary `defineState` values. The cursor
  rejects that on purpose.
- **Hold `agent.started` until the boundary.** Clients could not follow a child
  until the model step ended. The remote-agent stream proxy could not bind the
  child until then either.
- **Pre-assign the child session id in `task.started`.** This does not remove
  mid-step publication:
  - A local child's session id is its workflow run id. `createSession` returns
    `run.runId`, and `startLocalSession` returns `owner.runId`. That id exists
    only after the task's own run calls `openAgentSessionStep`, not during the
    parent's dispatch step. Pre-assigning it would require eve-generated
    session ids separate from run ids, which changes session identity and
    stream routing.
  - A remote child's id comes from the remote deployment, and the proxy binds
    the child from `agent.started`.
  - `ctx.agent` in `execute` and `serve` bodies opens sessions at any point,
    and possibly more than once per call. The parent cannot know those sessions
    at dispatch.

  With this plan, pre-assignment is not needed for hook correctness. It would
  only be a client-latency optimization with a large identity cost, so it is
  out of scope.

## Compatibility

- Hook state writes from `agent.started` are kept, including sandbox changes.
  The observer-only note in `docs/guides/hooks.md` is replaced with the general
  rule and the ordering caveat.
- `agent.started` hooks for mid-step arrivals run later than they do today. They
  run at the next boundary instead of beside the model step.
- The change needs a patch changeset. There is no hook contract epoch change,
  because `HookContext` does not change.

## Validation

- Integration: a pending dispatch runs first in the next state-owning step, and
  the cursor adopts its `defineState` write. A step retry leaves one copy of
  that write. Pending dispatches run before a park, a held-turn wait, a
  completion, and a failure. Pending dispatches are empty at handoff.
- E2E (`agent-workflow-tools`): Alice starts a background research task whose
  run opens a helper agent while the parent keeps answering her. An
  `agent.started` hook records the helper in session state, and a tool in
  Alice's next turn reads it back.

## Open questions

- Should `ctx.report()` updates (`action.partial` from runs) also be written
  during the model step? They qualify under the no-state-change criterion, and
  progress would become visible sooner. That would change client-visible timing.
- Should the dispatch-only step before a wait be kept? Without it, pending
  dispatches wait for the next state-owning step. That costs zero steps but can
  delay hooks until the next user message.
- Should finalization run pending dispatches in their own step, or inside the
  terminal event step? The terminal event step runs no hooks today, and #3401
  tracks that separately.
