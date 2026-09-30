---
issue: "None (maintainer-requested refactor)"
status: in-progress
last_updated: "2026-09-30"
---

# Session stream contract

A session's event stream is the only lifecycle record its readers get. eve's
channel activity, the web and TUI clients, and third-party consumers each
folded that stream into turns, requests, calls, and sign-ins. Wherever the
stream left a relation unstated, each reader inferred it on its own, and the
inferences disagreed in edge cases the server handled correctly.

This change does four things:

- It states those relations on the stream.
- It folds the stream once, in a pure projection that every reader shares.
- It writes down the rules every stream keeps as a checkable contract.
- It drives generated sessions against that contract.

[Turn state](./turn-state.md) covers the server-side state these events
come from.

## Protocol gaps and fixes

Each row is a fact the session knew but the stream did not say, what readers
did instead, and what the stream says now.

| #   | Gap                                                 | What readers did                                                                                                                                                 | Now                                                                                                       |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1   | Which turn a new turn continues                     | Buffered settlements seen between turns and attached them to the next `turn.started`. Depended on event order; a session boundary dropped the buffer.            | `turn.started.continuesTurnId`; the root is found by following it                                         |
| 2   | Which turn runs an approved call                    | The turn open when the approval resolved, else the next to start                                                                                                 | `resumeTurnId` on each approved resolution in `input.resolved`                                            |
| 3   | Which calls a sign-in stops                         | Every unsettled call in a closed turn that had an open sign-in                                                                                                   | `authorization.required.callIds`; each such call settles `cancelled`                                      |
| 4   | Which call a passed-up request belongs to           | The parent adopted the subagent's call as its own, guessed its status from task liveness, and UIs hid duplicates by matching followed child sessions' tool calls | Relayed `input.requested.callId` names the served call; the parent no longer records the subagent's call  |
| 5   | Which attempt a sign-in completion closes           | By `attemptId` when present, else by approval candidate, else the latest open attempt for the connection name                                                    | `attemptId` required on both authorization events                                                         |
| 6   | Calls eve abandons                                  | No result at all. Readers inferred cancellation from turn status, and a call that asked for a sign-in stayed "running" beside the sign-in                        | `action.result` status `cancelled`, with `AUTHORIZATION_REQUIRED`, `TURN_CANCELLED`, or `CONTEXT_CLEARED` |
| 7   | Denials reported as failures                        | A policy's automatic denial arrived as `failed` with `TOOL_EXECUTION_DENIED`; readers mapped the code                                                            | `rejected`, like every other denial                                                                       |
| 8   | Relayed requests' coordinates                       | A child's question named the child's own `turn_0`, so clients attached it to the root's first message                                                            | The served call's coordinates, with `taskId`                                                              |
| 9   | Silent withdrawals                                  | Cancel, clear, and a run ending dropped requests and sign-ins without an event; readers showed them as answerable                                                | `input.resolved` `cancelled` or `authorization.completed` `failed` before the event that ends the owner   |
| 10  | Order of a sign-in callback and the turn it resumes | `authorization.completed` could follow the resumed `turn.started`, at the new turn's coordinates                                                                 | It precedes it, at the asking turn's coordinates                                                          |
| 11  | Approval policy events' coordinates                 | They named the turn about to start                                                                                                                               | They name the step that asked for the approval                                                            |

Each fact costs the server no new durable state. Parked steps keep their
origin, pending sign-ins keep theirs, relayed runs carry `from.callId`, and
the next turn's ID is known before its `turn.started`.

### Found, not fixed here

- **Which parent call sent a child session's message.** A client nests a
  followed subagent's turns under the parent call that caused them by
  counting the child's user messages in call order. This rests on the rule
  that each agent-tool call sends exactly one message, in order. A call whose
  message never arrived shifts every later call.

  The child knows only the call that opened its session (`caller.callId`,
  fixed for the session's life). Stating the sender needs a per-message field
  in the session send API, carried through the remote-agent protocol, plus a
  rule for deliveries merged into one turn. That is a public API change and
  needs its own proposal.

- **A call cut off mid-step.** An abort discards the step's state, so the
  server does not know which of the calls it announced are running. The
  projection reads such a call as `cancelled` from its cancelled turn.

- **Stream loss.** When a stream stops, a reader can only call its running
  calls `interrupted`.

## Observable changes

For stream readers:

- `turn.started.continuesTurnId`, `InputResolution.resumeTurnId`,
  `authorization.required.callIds`, and `input.requested.callId` are new
  optional fields.
- `attemptId` is required on `authorization.required` and
  `authorization.completed`.
- `ActionResultStatus` gains `cancelled`. A call that asked for a sign-in
  settles `cancelled` with `AUTHORIZATION_REQUIRED` instead of `failed`, and
  an approved call that asks for one does the same. Both leave the model's
  history, and the model calls the tool again under a new call ID after the
  sign-in. An older client that doesn't know `cancelled` shows such a call as
  completed, with the error as its output.
- A parked call that a cancel or clear stops settles `cancelled` before its
  approval is withdrawn.
- A policy's automatic denial reports `rejected`.
- Withdrawals, relayed coordinates, sign-in completion order, and approval
  policy coordinates change as in rows 8–11.
- `turn.waiting` follows a relayed request only while the parent has an open
  turn.
- The stream version stays 26: every change adds a field or a value.

Server behavior fixes that come with this:

- A step with an approval beside a call that needs a sign-in never asked for
  the sign-in: the approval parked the step, and the call's "sign-in pending"
  output reached the model. It now asks, and the step parks without that
  call.
- A sign-in closed its turn while workflow runs still worked. The turn now
  stays open for them.
- An approved call that asked for a sign-in stayed in its parked step. When a
  running sibling later committed the step, the model read a "sign-in
  pending" result. The call now leaves the step.
- A response-policy pass that settled no approval (rejected, failed, expired,
  or waiting on a sign-in) started a turn and called the model. The session
  now keeps waiting.
- An approval a policy settled before its batch resolved lost the turn that
  runs it.
- An approval's first decision stands.

Clients (on the client stack):

- `toolCallState(conversation, part, { streaming })` reads `callStatus` from
  the shared projection. It uses the projection's statuses (`completed`,
  `rejected`, `cancelled`) and no longer takes a turn ID.
- `ConversationInput.callId` and `signInState()` are public. Sign-in parts
  always carry `attemptId`.
- A subagent's call that the parent shows only for its passed-up approval
  reads as the parent's task call once the approval settles.

`eve dev`:

- It warns when a session's stream breaks the contract.
  `EVE_SESSION_CONTRACT` is `record`, `warn`, or `off`.

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

Every relation in it is one an event states. It infers only what no event
can say: a call still running when its turn ended, or when the stream
stopped, was interrupted.

There are three readers:

- **Channel activity** (`execution/session-activity-projection.ts`). It
  replaces the activity cohort bookkeeping that copied root turn IDs into
  pending batches, parked steps, and sign-ins. It prunes settled work, but
  keeps a continuation turn's root link, since a later turn can continue it.
- **The contract checker.**
- **The client's `ConversationState`** (client stack). The public type keeps
  a curated set of fields; `calls`, `authorizations`, and `rootTurnId` stay
  internal.

## Stream contract

`protocol/session-contract.ts` checks each event against the stream before
it:

| Rule               | A reader may rely on                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `own-coordinates`  | an event names only turns this stream started and calls it announced, including `continuesTurnId`, `callId`, and `callIds`                       |
| `turn-order`       | one turn at a time, content inside its turn, nothing after the end; an approved call's `resumeTurnId` is present and names the open or next turn |
| `open-after-owner` | no request or sign-in outlives its task, its cancelled turn, a clear, or the session                                                             |
| `unsettled-call`   | a completed turn leaves no call without an outcome                                                                                               |
| `unasked-sign-in`  | a call settled for a sign-in is named by an `authorization.required` before its turn ends                                                        |
| `resolved-twice`   | a request resolves once                                                                                                                          |
| `state-agreement`  | where a step ends, the stream shows exactly the requests and sign-ins the session awaits                                                         |

`state-agreement` needs the session's state, so only the server checks it.
It skips a sign-in that a task's or workflow run asked, which the session
relays but does not await; `callIds` is what tells the two apart.

## Verification

```text
emit ──► contract checker ──► violations        (every event, in order)
step end ──► state vs projection ──► violations (every durable step)
generated sessions ──► both, after every action
```

- **Monitor** (`execution/session-contract-monitor.ts`). It runs the checker
  on every event a session emits, and the agreement check at every durable
  step end. The integration tier records violations and fails the test that
  caused them; `eve dev` warns.
- **Generated sessions** (`harness/generated-sessions.integration.test.ts`).
  Seeded random sequences of messages, answers, steering, workflow results,
  cancels, and clears, against a model that calls tools at random. The tools
  include ones that ask for a sign-in, inline and behind an approval, and
  running workflow calls pass requests up through the real relay code. It
  runs 40 seeds in CI; 1,500 pass locally.
- **Mutation checks** on 200 seeds. Removing the cancel withdrawals fails 15%
  of seeds, and the clear withdrawals 40%. Removing the sign-in ask beside an
  approval fails 55%, and closing the turn on a sign-in while runs work fails
  10%.

What found each defect, and what now catches it:

| Defect                                                            | Found by                  | Caught by                           |
| ----------------------------------------------------------------- | ------------------------- | ----------------------------------- |
| relayed requests used the child session's coordinates             | report                    | `own-coordinates`, unit test        |
| cancelling a task left its relayed requests open and routable     | report                    | `open-after-owner`, unit test       |
| cancel and clear withdrew requests and sign-ins without an event  | audit                     | generator, `state-agreement`        |
| a finishing workflow run dropped its questions without an event   | audit                     | `state-agreement`, unit test        |
| approval policy events named the turn about to start              | monitor                   | `own-coordinates`                   |
| a second answer overwrote an approval the stream reported settled | generator                 | `state-agreement`                   |
| a call that stopped for a sign-in never settled on the stream     | `eve dev` monitor         | `unsettled-call`, integration test  |
| a step with an approval never asked for its other call's sign-in  | generator (sign-in tools) | `unasked-sign-in`, integration test |
| a sign-in closed its turn while workflow runs worked              | generator (sign-in tools) | `unsettled-call`, integration test  |
| an approved call that asked for a sign-in stayed in its step      | review                    | integration test                    |
| a response-policy pass that settled nothing started a turn        | restored #3494 suite      | adversarial suite                   |
| a policy's automatic denial reported `failed`                     | restored #3983 scenario   | integration test                    |
| an approval a policy settled first lost its resume turn           | client adoption tests     | projection unit test                |

The turn state rewrite had dropped three suites. They are restored against
the new state: the #3983 approved-workflow scenarios, the approval-resume
suite (answers in one delivery, `once()` grants, the session-limit prompt, a
turn in between, dynamic tools), and the #3494 adversarial suite. Two
restored tests now encode #4018's rules rather than the old ones. Approvals
answered in one delivery resume in one model call. An approved call runs
before the session-limit prompt holds the model, since running it spends no
model tokens, as #3983 already decided for workflows.

## Out of scope

- Relayed requests stay in the proxy map rather than the turn state; they
  share one withdrawal function with it.
- A late answer to a withdrawn request is stale, as for any request the
  session no longer offers. A stale approval answer still reaches the model
  as text.
- Other folds of the stream outside the projection: the ACP adapter, the
  eval runner's run facts, and the channel-side activity batch. These are
  follow-up work.
