---
issue: "None (maintainer-requested refactor)"
status: in-progress
last_updated: "2026-09-30"
---

# Session stream contract

A session's event stream is the only lifecycle record its readers get. eve's
channel activity, the web and `eve dev` clients, and third-party consumers
each fold that stream into turns, requests, calls, and sign-ins. Wherever the
stream left a relation unstated, each reader guessed it from event order, and
the guesses disagreed in edge cases the server handled correctly.

This change:

- **states those relations on the stream**, as new fields and values;
- **reports every close**, so nothing a reader shows open was silently
  dropped;
- **folds the stream once**, in a pure projection that channel activity and
  the client share;
- **writes down the rules every stream keeps** and holds the streams eve's
  tests produce to them.

It builds on [Turn state](./turn-state.md), which keeps the server-side facts
these events come from.

## Protocol gaps and fixes

Each row is a fact the session knew but the stream didn't say, what readers
did instead, and what the stream says now.

| #   | Gap                                        | What readers did                                                                                                                                                 | Now                                                                                                       |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Which turn a new turn continues            | Buffered settlements seen between turns and attached them to the next `turn.started`. This depended on event order, and a session boundary dropped the buffer.   | `turn.started.continuesTurnId`; a turn's root is found by following it                                    |
| 2   | Which turn runs an approved call           | Assumed the turn open when the approval resolved, or else the next to start                                                                                      | `resumeTurnId` on each approved resolution in `input.resolved`                                            |
| 3   | Which calls a sign-in stops                | Assumed every unsettled call in a closed turn with an open sign-in                                                                                               | `authorization.required.callIds`; each such call settles `cancelled`                                      |
| 4   | Which call a passed-up request belongs to  | The parent adopted the subagent's call as its own, guessed its status from task liveness, and UIs hid duplicates by matching followed child sessions' tool calls | Relayed `input.requested.callId` names the served call; the parent no longer records the subagent's call  |
| 5   | Which attempt a sign-in completion closes  | Matched by `attemptId` when present, else by approval candidate, else the latest open attempt for the connection name                                            | `attemptId` required on both authorization events                                                         |
| 6   | Calls eve abandons                         | Got no result. Readers inferred cancellation from turn status, and a call that asked for a sign-in stayed "running" beside the sign-in                           | `action.result` status `cancelled`, with `AUTHORIZATION_REQUIRED`, `TURN_CANCELLED`, or `CONTEXT_CLEARED` |
| 7   | Denials reported as failures               | A policy's automatic denial arrived as `failed` with `TOOL_EXECUTION_DENIED`, and readers mapped the code                                                        | `rejected`, like every other denial                                                                       |
| 8   | Relayed requests' coordinates              | A child's question named the child's own `turn_0`, so clients attached it to the root's first message                                                            | The served call's coordinates, with `taskId`                                                              |
| 9   | Silent withdrawals                         | Cancel, clear, and a run ending dropped requests and sign-ins without an event, and readers kept showing them as answerable                                      | `input.resolved` `cancelled` or `authorization.completed` `failed`, before the event that ends the owner  |
| 10  | Order of a sign-in callback and its resume | `authorization.completed` could follow the resumed `turn.started`, at the new turn's coordinates                                                                 | It precedes that turn, at the asking turn's coordinates                                                   |
| 11  | Approval policy events' coordinates        | They named the turn about to start                                                                                                                               | They name the step that asked for the approval                                                            |

None of these facts needs new durable state. Parked steps keep their origin,
pending sign-ins keep theirs, relayed runs carry `from.callId`, and the next
turn's ID is known before its `turn.started`.

### Found, not fixed here

- **Which parent call sent a child session's message.** A client nests a
  followed subagent's turns under the parent call that caused them by counting
  the child's user messages in call order. That relies on each agent-tool call
  sending exactly one message, in order, so a call whose message never
  arrives shifts every later call. The child knows only the call that opened
  its session. Stating the sender needs a per-message field in the session
  send API and the remote-agent protocol, plus a rule for deliveries merged
  into one turn. That is a public API change and needs its own proposal.
- **A call cut off mid-step.** An abort discards the step's state, so the
  server doesn't know which of the calls it announced are running. The
  projection reads such a call as `cancelled` from its cancelled turn.
- **A cancel during a step that already reported progress.** A step that is
  cancelled commits the state it started from, plus any model call it
  completed. If the step had already resolved approvals or run approved calls
  before a model call it didn't finish, the cancel settles those again. A
  declined session-limit prompt hit this every time and is fixed; the general
  case needs the step to checkpoint what it reported.
- **Stream loss.** When a stream stops, a reader can only call its running
  calls `interrupted`.

## Observable changes

For stream readers:

- New optional fields: `turn.started.continuesTurnId`,
  `InputResolution.resumeTurnId`, `authorization.required.callIds`, and
  `input.requested.callId`.
- `attemptId` is required on `authorization.required` and
  `authorization.completed`.
- `ActionResultStatus` gains `cancelled`. A call that asks for a sign-in,
  inline or after its approval, settles `cancelled` with
  `AUTHORIZATION_REQUIRED` and leaves the model's history, and the model calls
  the tool again under a new call ID after the sign-in. A parked call that a
  cancel or clear stops settles `cancelled` before its approval is withdrawn.
- A policy's automatic denial reports `rejected`.
- Withdrawals, relayed coordinates, sign-in completion order, and approval
  policy coordinates change as in rows 8–11.
- `turn.waiting` follows a relayed request only while the parent has an open
  turn.
- The stream version stays 26, since every change adds a field or a value.
  A client that doesn't know `cancelled` shows such a call as completed, with
  the error as its output.

Server fixes that come with this:

- A step with an approval beside a call that needs a sign-in never asked for
  the sign-in: the approval parked the step, and the call's "sign-in pending"
  output reached the model. It now asks, and the step parks without that call.
- A sign-in closed its turn while workflow runs were still working. The turn
  now stays open for them.
- An approved call that asked for a sign-in stayed in its parked step. When a
  running sibling later committed the step, the model read a "sign-in
  pending" result. The call now leaves the step.
- A response-policy pass that settled no approval (rejected, failed, expired,
  or waiting on a sign-in) started a turn and called the model. The session
  now keeps waiting. The turn state change introduced this.
- An approval a policy settled before its batch resolved lost the turn that
  runs it.
- An approval's first decision stands: once `approval.settled` reports it, a
  second answer while sibling approvals are open changes nothing.
- Declining the session-limit prompt resolved the prompt, then the
  cancellation withdrew it again.

Channel activity reads the projection, so a call a failed turn cut off shows
as `interrupted`.

## Session projection

`protocol/session-projection.ts` is a pure fold over public events:

```ts
interface SessionProjection {
  activeTurnId?: string;
  turns: Record<string, SessionTurn>; // status, waiting, rootTurnId
  inputs: Record<string, SessionInput>; // status, outcome, callId, resumeTurnId
  tasks: Record<string, SessionTask>;
  calls: Record<string, SessionCall>; // turnId, requestId, taskId, result
  authorizations: Record<string, SessionAuthorization>; // by attemptId; callIds
}

function callStatus(
  p: SessionProjection,
  callId: string,
  o?: { streaming?: boolean },
):
  | "running"
  | "awaiting-input"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled"
  | "interrupted"
  | undefined;
```

Every relation in it is one an event states. It infers only what no event can
say: that a call still running when its turn ended, or when the stream
stopped, was interrupted.

Its readers:

- **Channel activity** (`execution/session-activity-projection.ts`). It
  replaces the activity cohort, which copied root turn IDs into pending
  batches, parked steps, and sign-ins. It keeps only open work, plus each
  continuation turn's root link, since a later turn can continue it.
- **The client's `ConversationState`**, in
  [#3986](https://github.com/vercel/eve/pull/3986). The public type keeps a
  curated set of fields; `calls`, `authorizations`, and `rootTurnId` stay
  internal, and `toolCallState()` reads `callStatus`.
- **The contract checker**, in tests.

## Stream contract

`internal/testing/session-contract.ts` checks each event against the stream
before it. The same rules are written for stream readers in
[Sessions, runs, and streaming](../docs/concepts/sessions-runs-and-streaming.md#stream-guarantees).

| Rule               | A reader may rely on                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `own-coordinates`  | an event names only turns this stream started and calls it announced, including in `continuesTurnId`, `callId`, and `callIds`                             |
| `turn-order`       | one turn at a time, content inside its turn, nothing after the session ends; an approved call's `resumeTurnId` is present and names the open or next turn |
| `open-after-owner` | no request or sign-in outlives its task, its cancelled turn, a clear, or the session                                                                      |
| `unsettled-call`   | a completed turn leaves no call without an outcome                                                                                                        |
| `unasked-sign-in`  | a call settled for a sign-in is named by an `authorization.required` before its turn ends                                                                 |
| `resolved-twice`   | a request resolves once                                                                                                                                   |
| `state-agreement`  | where a step ends, the stream shows exactly the requests and sign-ins the session awaits                                                                  |

`state-agreement` compares the projection with the session's turn state,
relayed requests, and pending sign-ins, so only a test that holds the session
state can check it. It skips a sign-in that a task's or workflow's run asked
for, which the session relays but doesn't await; `callIds` is what tells the
two apart.

## Verification

The checker is a test oracle and doesn't ship in eve. Tests run it wherever
they observe a session:

| Where                                   | Checks                                                       | Covers                                                                |
| --------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------- |
| `internal/testing/tool-loop-fixture.ts` | every event, and state agreement after each harness step     | the turn state and approval-resume suites, and the generated sessions |
| `captureTurnEvents` and `captureEvents` | every event of a workflow stream a test reads from its start | the 13 integration suites that read a session's workflow stream       |

**Generated sessions** (`harness/generated-sessions.integration.test.ts`) run
seeded random sequences of messages, answers, steering, workflow results,
cancels, and clears against a model that calls tools at random. The tools
include ones that ask for a sign-in, inline and behind an approval, and
running workflow calls pass requests up through the real relay code. CI runs
40 seeds; 1,500 pass locally. On 200 seeds, removing the cancel withdrawals
fails 15% of seeds and removing the clear withdrawals 40%. Removing the sign-in
ask beside an approval fails 55%, and closing the turn on a sign-in while runs
work fails 10%.

An earlier version also ran the checker inside eve, on every emitted event
and every durable step end, warning under `eve dev` and recording for the
integration tier. Moving it into tests took about 420 lines of production code
out of this change: the monitor, the `EVE_SESSION_CONTRACT` variable, the
checker itself, and their hooks. The integration-tier recording also never
reached a test for sessions the workflow bundle ran, since the bundle holds
its own copy of the monitor. That hid the declined session-limit prompt's
second resolution until the stream readers checked it.

What found each defect, and what catches it now:

| Defect                                                            | Found by                     | Caught by                           |
| ----------------------------------------------------------------- | ---------------------------- | ----------------------------------- |
| relayed requests used the child session's coordinates             | report                       | `own-coordinates`, unit test        |
| cancelling a task left its relayed requests open and routable     | report                       | `open-after-owner`, unit test       |
| cancel and clear withdrew requests and sign-ins without an event  | audit                        | generator, `state-agreement`        |
| a finishing workflow run dropped its questions without an event   | audit                        | `state-agreement`, unit test        |
| approval policy events named the turn about to start              | in-process monitor (removed) | `own-coordinates`                   |
| a second answer overwrote an approval the stream reported settled | generator                    | `state-agreement`                   |
| a call that stopped for a sign-in never settled on the stream     | `eve dev` monitor (removed)  | `unsettled-call`, integration test  |
| a step with an approval never asked for its other call's sign-in  | generator (sign-in tools)    | `unasked-sign-in`, integration test |
| a sign-in closed its turn while workflow runs worked              | generator (sign-in tools)    | `unsettled-call`, integration test  |
| an approved call that asked for a sign-in stayed in its step      | review                       | integration test                    |
| a response-policy pass that settled nothing started a turn        | restored #3494 suite         | adversarial suite                   |
| a policy's automatic denial reported `failed`                     | restored #3983 scenario      | integration test                    |
| an approval a policy settled first lost its resume turn           | client adoption tests        | projection unit test                |
| a declined session-limit prompt resolved twice                    | workflow stream checks       | `resolved-twice`, integration test  |

The turn state change dropped three suites, and this change restores them
against the new state: the [#3983](https://github.com/vercel/eve/pull/3983)
approved-workflow scenarios, the approval-resume suite (answers in one
delivery, `once()` grants, the session-limit prompt, a turn in between, and
dynamic tools), and the [#3494](https://github.com/vercel/eve/issues/3494)
adversarial suite. Two restored tests now encode the turn state's rules rather
than the old ones: approvals answered in one delivery resume in one model call,
and an approved call runs before the session-limit prompt holds the model.

## Size

In `packages/eve/src`, production code grows by about 870 lines (+1,458,
−586) and tests by about 2,840 (+3,534, −696). Most of the production growth
is the projection (about 500 lines) and channel activity on top of it (+200,
−52). The activity cohort, the proxy-request clears, and the old sign-in
inference go.

## Out of scope

- Relayed requests stay in the proxy map rather than the turn state; they
  share one withdrawal function with it.
- A late answer to a withdrawn request is stale, as for any request the
  session no longer offers. A stale approval answer still reaches the model as
  text.
- Other folds of the stream outside the projection: the ACP adapter, the eval
  runner's run facts, and the channel-side activity batch. These are follow-up
  work.
