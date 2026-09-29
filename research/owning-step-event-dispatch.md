---
issue: "None (follows closed PR #3982; no matching issue found)"
status: proposed
last_updated: "2026-09-29"
---

# Owning-step event dispatch

This plan separates writing a session event from dispatching it to its channel adapter handler and
stream-event hooks, so every hook's session state writes are kept. It states the semantics and
cost, inventories what is removed or reshaped, and lands the change as a stack of pull requests.
Paths are relative to `packages/eve/src/`.

## Summary

1. **Session state has one writer at a time.** Each state-owning step returns a delta from the
   state it was given, and `SessionStateCursor.advance` throws if the state changed while the step
   ran. A write made beside the running step is lost.
2. **Dispatch can write state.** Hooks write through `defineState` and the sandbox, and adapter
   handlers write adapter state, so dispatch must run inside a state-owning step.
3. **One event breaks this today.** An `agent.started` that arrives while a model step runs is
   published by `StepAgentStarts.publishWhile` in a separate step whose result is never adopted.
   `docs/guides/hooks.md` tells authors to treat `agent.started` hooks as observers.
4. **The rule:** every event is written when it happens. Its dispatch runs in the step that
   produced it, or, for an event written beside another step, first thing in the next
   state-owning step. A dispatch-only step runs whatever is still pending before the session
   waits, hands off, or ends.
5. **Delete first, then rebuild.** PR 1 removes the mid-step path, so `agent.started` publishes at
   the next boundary and keeps its hooks' state. Later PRs split write from dispatch and restore the
   early write through the general path.

No public API changes. `HookContext` is unchanged.

## 1. Current behavior

The session workflow body threads one state pair through its steps with `SessionStateCursor`
(`execution/session/state-cursor.ts`). Every step that changes session state goes through
`cursor.advance` and returns a delta through `withSessionStateDelta`
(`execution/session/state-delta.ts`).

Nearly every event is dispatched inside a state-owning step:

- **Turn events.** `turnStep` dispatches `step.*`, `action.*`, `turn.*`, and message events inline
  through `createTurnEventHandler` (`execution/session/turn-event-handler.ts`). Hooks there can
  call `ctx.cancel()`.
- **Boundary events.** Messages from other workflow runs, such as task replies, `ctx.report()`
  updates, questions, and withdrawals, wait in the session inbox. Each is applied in its own step
  at the next boundary, such as `applyTaskRunMessageStep`, `emitWorkflowToolRunReportStep`, or
  `runProxySubagentEventStep`. Each costs one durable step, and its hooks' state writes are kept.
- **`agent.started` outside a model step.** During a blocking wait, a held turn, or between
  turns, `agent.started` takes the boundary path through `emitAgentStartedStep`, and its hooks'
  state writes are kept.

The exception is an `agent.started` that arrives while `turnStep` runs. Clients follow a child from
that event, and the remote-agent stream proxy binds a remote child by finding it in the parent
stream (`findRemoteAgentBinding` in `eve-channel/support.ts`). A model step can run for a long
time, so `publishWhile` publishes the event right away in a separate `emitAgentStartedStep` and
drops that step's result. The adapter handler and hooks run against a copy of state that is then
thrown away.

Terminal `session.completed` and `session.failed` events are a separate case. They are published
outside a turn by `publishTerminalSessionEvent`, which calls the adapter handler with no session
scope and runs no hooks. #3401 tracks this. This plan does not change it unless that is decided
(§8).

## 2. Semantics

```text
workflow body (cursor)                 durable steps
────────────────────────────           ──────────────────────────────────────
advance(turnStep N) ─────────────────▶ turnStep N
                                         own events: deliver, write, hooks
  run message arrives mid-step
  └─ write step ─────────────────────▶ write agent.started only
     pending += stamped event
adopt delta N
advance(next step, pending) ─────────▶ next state-owning step
                                         1. dispatch pending, in write order
                                         2. own events: deliver, write, hooks
adopt delta; pending = []
about to wait, hand off, or end?
  pending non-empty ─────────────────▶ dispatch-only step
```

### Where pending dispatches run

| After the step that was running                                              | Pending dispatches run in                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------ |
| Next model step, coordination dispatch, task message, steering route, cancel | That step, before its own events                 |
| Turn parks, holds on tasks, or waits on results, or the session awaits input | One dispatch-only step before the body waits     |
| Session completes or fails                                                   | One dispatch-only step before the terminal event |
| Handoff to a successor run                                                   | None pending. Handoff happens only after a wait  |

`bindTurnCallerContextStep` receives only serialized context. It passes pending dispatches on to
the next step that receives the full session state. Pending dispatches are empty whenever the
workflow body waits for input, hands off, or ends. Hook latency is bounded by the next boundary,
never by the next user message.

### Durability and replay

The write step returns the stamped event, so pending dispatches are derived from durable step
results, and replay rebuilds them. The cursor passes them in the next step's input and clears them
only when it adopts that step's result.

A retried step dispatches them again with the same event and `meta.id`. The failed attempt's state
is discarded with it, so each dispatch's state writes land in committed state exactly once. Handler
invocation and external side effects stay at-least-once, which is the contract
`docs/guides/hooks.md` documents for every hook. A retried write step can write the event twice,
as documented today. Only the attempt that completes becomes pending.

### Ordering

- Every event is dispatched after it is written. This is unchanged.
- Events one step produces are dispatched in stream order within that step. This is unchanged.
- Pending events are dispatched in write order, before any event of the step that runs them.
- A pending event is dispatched after the hooks of every event the running step wrote after it. If
  a child opens during the model step that ends the turn, a `*` hook sees `turn.completed` and
  `session.waiting` before `agent.started`.

Hook order is stream order within each producing step, not global stream order. With one writer
at a time, the only way to avoid this is to delay in-step dispatch, which would break
`ctx.cancel()` and model preparation. Consumers that need global order sort by `meta.id`.

### Hook and channel context

- A pending dispatch sees session state as committed when its step starts. That state can include
  changes from the step that was running when the event was written.
- `ctx.cancel()` from a pending dispatch is ignored with the existing "not part of a running turn"
  warning, as it is for boundary events today.
- For a pending event, channel delivery runs after the write, together with the hooks. Channel
  delivery covers the activity-state update, the adapter handler (or `forwardSessionInput` for a
  remote session's input events), and the channel context. For in-step events, the documented order
  is unchanged: deliver, stamp, write, hooks. A pending event's adapter handler can no longer
  mutate the event's data before the write. The outbound activity projection already runs after the
  write, and it moves with dispatch. For `agent.started`, both activity paths are no-ops today.

### Failure paths

- If a step fails the session, finalization runs pending dispatches in one dispatch-only step
  before `session.failed`, against the last committed state. Their state writes don't matter
  because the session ends. External side effects, such as a `*` audit hook, still run. That
  matches in-step events, whose hooks ran during the failed attempt. A failure in this step is
  logged and does not block the terminal event.
- If a turn is cancelled, `settleCancelledTurnStep` owns state, so pending dispatches run there.

### What stays the same

For events a state-owning step produces, nothing changes: dispatch timing, `ctx.cancel()`
eligibility, memory lifecycle, dynamic model, tool, skill, and instruction preparation,
instrumentation, and the documented emit order.

## 3. Cost

Costs are durable steps per `agent.started` that arrives while a model step runs. No latency was
measured for this plan.

| State                    | Extra durable steps                                               | Critical-path effect                                              |
| ------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `main` today             | 1 write-and-dispatch step beside the model step                   | Overlaps the model step. Hook state is dropped                    |
| After PR 1               | 1 boundary step after the model step                              | +1 sequential step, and clients see the event only after the step |
| After PR 3, subscribed   | 1 write step beside the model step, plus 0 or 1 dispatch step     | The hooks' own duration in the next step                          |
| After PR 3, unsubscribed | 1 write step beside the model step. Nothing becomes pending       | Same as `main`                                                    |
| #3982, subscribed        | 1 write step beside, plus 1 dispatch step per model step with one | +1 sequential durable step before the next boundary               |

A subscriber is an adapter handler for the event type, a typed hook, or a `*` hook. `*`
persisters are common, so the subscribed case is realistic. After PR 3, the dispatch step is
needed only when no state-owning step follows before the body waits or ends. That step runs after
the turn's terminal events and any delegated-caller notification, so it does not delay the turn a
client or parent sees. Input that arrives during it waits for it. Before a terminal event, it delays
`session.completed` or `session.failed` by one step.

## 4. Removed and changed

The removable surface is small. One special-case path is duplicate and wrong. The rest of the
publication machinery is either legitimately distinct or fused in a way that needs reshaping, not
deleting.

| Item                                                                    | Verdict                | Evidence                                                                                    |
| ----------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `StepAgentStarts`, its `publishWhile` wrapper, and its `consume` check  | Delete (PR 1)          | The only publisher beside the owning step. Its step result is never adopted                 |
| `onAgentStarted` on the session inbox                                   | Delete (PR 1)          | Only `StepAgentStarts` calls it. 21 test fakes stub it as `() => () => {}`                  |
| `emitAgentStartedStep`                                                  | Keep                   | The boundary path runs it through `cursor.advance`, where state is kept                     |
| `hasStreamEventHooks`                                                   | Not on `main`          | It existed only on #3982                                                                    |
| `openSessionEventStream().emit`                                         | Reshape (PR 2)         | The only caller of the adapter handler and activity paths. It fuses delivery with the write |
| `withSessionEventEmitter`, `publishSessionEvents`, `relaySessionEvents` | Reshape (PR 2)         | One composition. The wrappers exist for the distinct `own` and `relayed` origins            |
| `createSessionEventSink` with `createTurnEventHandler`                  | Keep, recompose (PR 2) | Turn-only memory, cancel, and resolver dispatch. It repeats only write-then-hooks           |
| `publishTerminalSessionEvent`                                           | Reshape write (PR 2)   | Its unrouted fallback write keeps the stream ending. Its missing hooks are #3401            |
| Publication envelope in three places                                    | Merge (PR 2)           | `publishFromStep`, `emitProxiedSubagentEvent`, and `settleCancelledTurn` repeat it          |
| Per-message publish steps                                               | Keep                   | Each makes a distinct state change in its own state-owning step                             |
| `dispatchStreamEventHooks` and `HOOK_CANCELLABLE_EVENTS`                | Keep                   | One fan-out with failure isolation, and a total map over hook events                        |
| Publication and hook-lifecycle integration tests                        | Keep                   | They pin behavior, not the special case. No test pins `publishWhile`                        |

The per-message publish steps are `emit-workflow-tool-run-report-step.ts`, `tasks/steps.ts`,
`coordination-dispatch-step.ts`, `settle-cancelled-turn-step.ts`, `turn-waiting-step.ts`,
`subagents/event-proxy-step.ts`, `withdraw-step.ts`, and `proxied-deliver-step.ts`. The
integration tests are `publish-session-events.integration.test.ts` (2 tests) and
`hook-lifecycle.integration.test.ts` (6 tests).

User-visible changes over the stack: `agent.started` hooks keep their session state and sandbox
changes. The observer-only note in `docs/guides/hooks.md` is replaced with the general rule and the
ordering caveat.

## 5. Delivery

The work lands as a stack of pull requests on top of this plan's PR. Each PR is one coherent step
from the one below it, passes CI on its own, and updates the docs its behavior change makes false.
`main` may lose features between PRs, never correctness. From PR 1 on, every hook state write is
kept. Every PR carries a `patch` changeset, as `AGENTS.md` requires. **Hold the Changesets release
from PR 1 until PR 3 merges**, so no release ships `agent.started` delayed to the boundary.

### Implementation rules

- **Remove first, then narrow steps.** PR 1 deletes the special case and the test stubs that exist
  for it. Every later PR changes only what its step needs, and unrelated cleanup waits.
- **The bar for each PR is a passing build.** `pnpm build`, `pnpm typecheck`, `pnpm lint`, and
  `pnpm guard:invariants` pass, and CI is green. An existing test that a PR breaks is updated if it
  still describes intended behavior and deleted if it doesn't.
- **Few tests during implementation.** Don't add tests that restate the code just written.
  Reviewers prove each PR correct by reading it. Add a test only when a PR can't be trusted without
  one. PR 3's replay behavior is the likely exception. Coverage comes after the stack (§6).
- **Code quality comes first.**
  - Write readable code, not compact code. Name each step, and extract a helper wherever a step has
    a name.
  - Define explicit interfaces at module boundaries: the session event writer, the dispatcher, a
    pending dispatch record, and the early-write classification of run messages.
  - Keep publication in `execution/publish-session-events.ts`. Keep the core lean: no harness or
    tool-loop changes, no legacy fallbacks.

| #   | PR                                       | Main after it lands                                                                 |
| --- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| 1   | Remove the mid-step `agent.started` path | `agent.started` publishes at the next boundary, and its hooks keep state            |
| 2   | Split write from dispatch                | Same behavior. Delivery, write, and observation are operations every publisher uses |
| 3   | Pending dispatch and early write         | `agent.started` is written mid-step again, and dispatched in the next owning step   |
| 4   | Tests and release readiness              | E2E coverage, the hooks guide, release                                              |

**1. Remove the mid-step `agent.started` path.** Delete `step-agent-starts.ts`, the
`publishWhile` wrapper in `SessionExecution.runTurnSteps`, `ActiveTurn.agentStarts` and its
`consume` check in `admit`, `onAgentStarted` on the inbox, and the 21 test stubs. `agent.started`
from a task run is then admitted at the boundary, taken by `takeTaskMessages`, and published through
`cursor.advance(emitAgentStartedStep)`. From an `execute` run, it already arrives during the turn's
wait. Update the `agent.started` paragraph in `docs/guides/hooks.md`. `agent-fanout.wait` opens its
children during a blocking wait, so it keeps passing unchanged.

**2. Split write from dispatch.** Split `openSessionEventStream().emit` into named operations:

- delivery: activity-state update, `forwardSessionInput` or the adapter handler, and channel context
- write: stamp, then write
- observation: activity projection and `dispatchStreamEventHooks`

Dispatch is delivery plus observation. In-step publication composes the operations as deliver,
write, observe. `withSessionEventEmitter`, `createTurnEventHandler`, and
`publishTerminalSessionEvent` all use these operations, and the repeated envelope becomes one
helper. Terminal events keep today's behavior: delivery without
session scope, no hooks, and the degraded write. No behavior changes.

**3. Pending dispatch and early write.** The cursor carries pending dispatches (stamped event and
origin) into the next step that receives the full session state. That step runs them through the
shared `withSessionStateDelta` wrapper before its own work. The cursor clears them on adoption. A
dispatch-only step runs before the body waits for input, hands off, or finalizes. Mid-step writes
return through one general writer, driven by a total map over `WorkflowToolRunMessage["kind"]` that
says which kinds may be written before dispatch. A kind qualifies only when producing its event
needs no session state change. Today only `agent-started` qualifies. `task.settled`, for example,
is produced by the task-table update it reports. A message already written this way is admitted
without being written again. Add the ordering caveat to `docs/guides/hooks.md`.

**4. Tests and release readiness.** The test pass in §6, the "Execution order" section of
`docs/guides/hooks.md` rewritten around write and dispatch, then release.

## 6. Tests after the stack

Tests are written once the stack has landed and the build is green, starting with e2e suites under
the fixtures they exercise.

**E2E (mock model), in `agent-workflow-tools`,** extending its `subagent-hook-audit` state and
sandbox audit to `agent.started`:

- Alice starts a background research task whose run opens a helper agent while the parent keeps
  answering her. Typed and `*` `agent.started` hooks record the helper in `defineState` and the
  sandbox, and a tool in Alice's next turn reads both back.
- Bob's blocking workflow tool opens two agents during its wait. The hooks record both, and the
  existing ordering assertion in `agent-fanout.wait` still holds.
- A throwing typed `agent.started` hook keeps its recorded state, and the `*` hook still runs.
- The existing `agent-subagents` stream suites, including the remote stream proxy, keep following
  children from `agent.started`.

**Candidates beyond e2e,** decided in this pass because e2e can't hit them deterministically:

- an arrival during a model step, written mid-step and dispatched first in the next step
- a step retry that dispatches again with the same `meta.id` and commits one state write
- pending dispatches drained before a park, a held-turn wait, completion, and failure, and empty at
  handoff
- a `*` hook that sees `turn.completed` before an `agent.started` written during the final step
- a write-step retry that writes twice and dispatches once

No real-model evals are needed. Nothing model-facing changes.

## 7. Alternatives considered

- **Special-case `agent.started` (#3982, closed).** This PR wrote the event mid-step with no
  dispatch, then dispatched it in a new `publishWrittenEventsStep` after the model step's result
  was applied. It made `sessionWritable` optional on the emitter to mean "already written," and
  review called that a smell. It cost one sequential durable step for each model step that wrote a
  subscribed `agent.started`. Its first revision also skipped the deferred hooks when the model
  step failed. It was closed in favor of a structural fix, because one event needed its own dispatch
  path.
- **Merge concurrent state deltas.** Merging would give up single-writer state and need conflict
  rules for arbitrary `defineState` values. The cursor rejects that on purpose.
- **Stop at PR 1.** It is correct, but clients and the remote stream proxy wait for the model step
  to end before they can follow a child.
- **Pre-assign the child session id in `task.started`.** This does not remove the need for a
  mid-step write:
  - A local child's session id is its workflow run id. `createSession` returns `run.runId`, and
    `startLocalSession` returns `owner.runId`. That id exists only after the task's run calls
    `openAgentSessionStep`.
  - A remote child's id comes from the remote deployment.
  - `ctx.agent` in `execute` and `serve` bodies opens sessions at any point, possibly several per
    call.

  Pre-assigning ids would also change session identity and stream routing. It is out of scope.

## 8. Open questions

- **Terminal events (#3401).** Should out-of-turn `session.completed` and `session.failed` be
  dispatched to hooks with session scope? PR 3 gives finalization a dispatch-only step that restores
  context, so a PR 3a could publish the terminal event there and close #3401. That is a
  behavior change for authored hooks and channel handlers, so the stack leaves it out unless it is
  chosen.
- **`ctx.report()` updates.** They qualify for the early write. Writing them mid-step would make
  task progress visible sooner and change client-visible timing.
- **Dispatch-only step before a wait.** Without it, pending dispatches wait for the next
  state-owning step. That costs no step but can delay hooks until the next user message.
- **Release hold.** Is holding the release from PR 1 through PR 3 acceptable? The alternative is
  releasing PR 1 alone, which delays `agent.started` to the boundary.
