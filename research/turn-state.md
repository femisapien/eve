---
issue: "None (maintainer-requested refactor)"
status: in-progress
last_updated: "2026-09-30"
---

# Turn state

A session's pending work used to live in six records, each persisted and
cleaned up on its own:

| Record                     | What it held                                                              |
| -------------------------- | ------------------------------------------------------------------------- |
| pending input batches      | one approval batch per model step, with the response messages it withheld |
| pending coordination batch | workflow and task calls waiting to dispatch                               |
| deferred step input        | input that arrived while an approval batch was unresolved                 |
| workflow tool run registry | running workflow calls and the runs that serve them                       |
| approval grants            | `once()` approvals already given in this context                          |
| harness emission state     | the turn's ID, sequence, and step index, with `""` meaning between turns  |

Each operation had to update every record it touched, and several didn't.
`clear` left approvals answerable, so a later answer ran a tool call from the
cleared context. A workflow call could dispatch while its approval was still
open ([#3983](https://github.com/vercel/eve/pull/3983) added a dispatch filter for that case). Approval responses were
replayed through the AI SDK, which needed the approval messages at the tail of
history, so new input was deferred behind them and batches resolved one at a
time.

This change keeps all of that in one durable record, `TurnState`, and moves
every lifecycle transition, and the stream events it produces, into one module.
The event protocol keeps its shape; what changes is listed under
[Observable changes](#observable-changes).

[Session stream contract](./session-stream-contract.md) builds on this: it
makes every close report what it dropped, states the relations readers used
to infer, and holds every stream to a checked contract.

## Primitives

```text
session ─ turn ─ parked step ─ call ─ wait
```

- **Turn.** At most one turn is open. Its `turnId`, `sequence`, and
  `stepIndex` are the coordinates every event carries. No open turn means the
  session is between turns.
- **Parked step.** One model response whose calls have not all settled. It
  holds the response messages back from history and commits them exactly once,
  when every call has a result.
- **Call.** One tool call in a parked step: `awaiting-approval`, `approved`,
  `ready`, `running`, or `settled`. Only `ready` workflow calls dispatch.
- **Wait.** What a call or the session is blocked on. An approval is a wait on
  its call; the session-limit prompt is a wait on the session.

## Durable state

Everything lives under one key, `eve.session`, in `session.state`:

```ts
interface TurnState {
  version: 1;
  started: boolean; // session.started was emitted
  sequence: number; // the open turn's sequence, or the next turn's
  turn?: { id: string; stepIndex: number; outputStarted?: boolean };
  steps: ParkedStep[]; // oldest first
  prompt?: LimitPrompt; // the session-limit continuation prompt
  queued?: StepInput; // input held behind the prompt or an approval policy phase
  grants: string[]; // approval keys granted in this context
}
```

`DURABLE_SESSION_VERSION` moves to 2 and `SESSION_CHECKPOINT_VERSION` to 11.
A session checkpointed by an earlier version fails with the existing "start a
new session" error, and a handoff from an earlier deployment keeps the session
on its current owner. Legacy-driver imports carry over only the turn
coordinates.

Relayed requests (questions and approvals a task's run passes up) and pending
sign-ins keep their own keys beside the turn state. Each relayed request
records the run that passed it up, and a pending sign-in records the
coordinates it was asked at.

## Call lifecycle

```mermaid
stateDiagram-v2
  [*] --> AwaitingApproval: tool approval requested
  [*] --> Ready: deferred workflow call
  [*] --> Running: task tool call
  AwaitingApproval --> Ready: approved (workflow)
  AwaitingApproval --> Approved: approved (inline)
  AwaitingApproval --> Settled: denied
  Approved --> Settled: eve runs the call
  Ready --> Running: runtime starts the run
  Running --> Settled: runtime result
  AwaitingApproval --> Settled: turn cancelled
  Ready --> Settled: turn cancelled
  Running --> Settled: turn cancelled
  Settled --> [*]
```

eve runs approved inline calls itself, in the turn that resumes them and
before the model reads their results, instead of replaying the approval
through the AI SDK. A call eve runs this way sees the history the model
reads in `ctx.messages`. Because no approval message has to sit at the tail
of history, input no longer waits behind an approval batch, and every batch
answered in one delivery resumes together. An approval's first decision
stands: once `approval.settled` reports it, a second answer while sibling
approvals are open changes nothing.

## Turn phase

The phase is derived, never stored:

- A `ready` or `running` workflow or task call exists: the turn waits on the
  runtime, which dispatches the calls and collects their results.
- Only approvals or the prompt remain: the turn closes with
  `input.requested`, `turn.completed`, and `session.waiting`.
- Otherwise the model runs, or the turn completes.

## Scope closes

Every close that drops pending work reports it before the event that ends
the owner, at the coordinates that asked for it.

| Operation | Effect on the turn state                                                                                                                                 | Reported as                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| cancel    | settles the turn's unsettled calls, and every approved, ready, or running call, as cancelled; commits their steps; drops the prompt and relayed requests | `action.result` `cancelled` (`TURN_CANCELLED`), `input.resolved` `cancelled`, then `turn.cancelled`                                           |
| clear     | drops every parked step, the prompt, queued input, grants, and pending sign-ins, and empties history. Requests relayed from live tasks stay routable     | `action.result` `cancelled` (`CONTEXT_CLEARED`), `input.resolved` `cancelled`, and `authorization.completed` `failed`, then `context.cleared` |
| run ends  | a task's or workflow call's run finishes or is stopped; drops the requests it relayed                                                                    | `input.resolved` `cancelled`, then `task.settled` or `action.result`                                                                          |
| reset     | ends the session, as before                                                                                                                              |                                                                                                                                               |

Withdrawals go through three functions: `emitStoppedCalls(before, after)` and
`withdrawnRequests(before, after)` for the turn state, and
`withdrawProxyInputRequests(session, select)` for relayed requests. Each
reports what the close dropped. The silent removals they replace,
`clearAllProxyInputRequests` and `clearProxyInputRequestsWhere`, are gone.

## Event projection

| Transition                 | Event                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| turn opened                | `session.started` (once), `turn.started` (with `continuesTurnId` when it resumes work), `message.received` |
| step started               | `step.started`                                                                                             |
| step parked with approvals | `input.requested`                                                                                          |
| approvals decided          | `input.resolved` (with each approved call's `resumeTurnId`), and `action.result` for a rejection           |
| call stopped for a sign-in | `action.result` (`cancelled`, `AUTHORIZATION_REQUIRED`), then `authorization.required` (`callIds`)         |
| call stopped by a close    | `action.result` (`cancelled`)                                                                              |
| request withdrawn          | `input.resolved` (`cancelled`)                                                                             |
| sign-in withdrawn          | `authorization.completed` (`failed`)                                                                       |
| call settled               | `action.result`                                                                                            |
| turn closed                | `turn.completed`, `turn.failed`, or `turn.cancelled`                                                       |
| session idle               | `session.waiting`                                                                                          |

## Observable changes

- `clear` withdraws pending approvals, the session-limit prompt, and pending
  sign-ins. An answer to one of them no longer runs the earlier call.
- An approved call runs before the model's next call reads its result.
  Approvals answered in one delivery resume in one model call, and an approved
  call runs before the session-limit prompt stops the model, since running it
  spends no model tokens.
- Workflow calls dispatch only once they are `ready`. #3983's dispatch filter
  becomes the call lifecycle.
- Answering some of a step's approvals emits `approval.settled` for each and
  then `session.waiting`, so the delivery reaches a boundary. Before, a
  partial answer emitted no boundary, and its `respond()` waited until the
  last approval was answered.
- Sessions from an earlier eve version can't resume on, or hand off to, this
  one.

## Replaced modules

`pending-input-batches`, `input-requests`, `coordination` (batch state),
`workflow-dispatch`, `workflow-tool-runs`, `hitl/pending-input-resolution`,
`hitl/approval-input-requests`, `hitl/session-limit-input-requests`,
`emission-state`, `active-turn-id`, `cancelled-turn-emission`, and
`execution/session/pending-turn-state`. The new modules are `turn-state`,
`parked-calls`, `runtime-calls`, `session-lifecycle`, and `step-input`. The
stream contract change also replaces `activity-cohort` with the shared session
projection.

Production code in `packages/eve/src` shrinks by about 850 lines (+2,468,
−3,318). Tests shrink by about 6,700 lines: suites written against the
replaced records go. This change ports four of #3983's cases into
`turn-state.integration.test.ts`. The session stream contract change restores
the rest of #3983's suite, the approval-resume suite, and the
[#3494](https://github.com/vercel/eve/issues/3494) adversarial suite against the turn state.

## Known gaps

The stream contract change reports every close and restores the approval
suites this change drops; see [Session stream contract](./session-stream-contract.md)
for what remains.
