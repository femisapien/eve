---
issue: "None (maintainer-requested research)"
status: proposed
last_updated: "2026-09-30"
---

# One source of truth for session state

## Summary

eve works out where a session stands in many places. On the server, pending work, relayed
requests, sign-ins, tasks, and approval candidates each keep a durable record. The code that
changes a record must also emit the matching stream event. Clients and eve's own readers fold
the same events with their own rules. Many of the bugs found while hardening the session stream
were two of these copies disagreeing.

This proposal gives each piece of session state exactly one owner:

- a turn state module, which alone changes pending work and builds lifecycle events;
- a session projection folded from those events, which answers every lifecycle question;
- private records keyed by what the projection tracks;
- caches written in one place.

Clients read the same projection.

## Background

This builds on the open stack:

- #4018 (`research/turn-state.md`) replaces six pending-work records with one `TurnState`.
- #4044 (`research/session-stream-contract.md`) adds a shared `SessionProjection`. It also adds
  the stream facts that make the projection exact: turn relations, withdrawals, and answer
  delivery IDs.
- #3922 (`research/client-conversation-state.md`) proposes `ConversationState` as the client
  fold.

This document supersedes `research/server-session-projection.md` in #4044. Unless stated
otherwise, counts below describe the code with the stack applied.

## Problem

### Many ways to compute the same state

| Question                                     | Where eve answers it                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is a turn open? Is the session idle?         | turn state (`activeTurnId`, `isBetweenTurns`), the cached `DurableSessionState.turn`, `isSessionStateIdleForHandoff`, `SessionProjection.activeTurnId`, client `TurnSegment`, `EveAgentStore` status, `derive-run-facts`, the ACP adapter |
| What is pending?                             | turn state's parked approvals and prompt, the relayed-request map and its cached `hasProxyInputRequests`, pending sign-ins, the task table, approval candidates, projection inputs and sign-ins, message parts                            |
| Where does a call stand?                     | `ParkedCall.status`, the task table, projection `callStatus`, `part.state`, `toolCallState`, `derive-run-facts`, the ACP adapter                                                                                                          |
| Which turn or call does something belong to? | event coordinates, `TurnDeliveryIdsKey`, `rootTurnOf`, `agentCallTurns` (copied into the web template), `followedAgentToolCallIds`                                                                                                        |

### Why they drift

1. **Changing a record and emitting its event are separate statements.** Six modules besides
   `turn-state.ts` write turn state, and lifecycle events are built in 16 files. Every site must
   do both halves.
2. **Records keep copies of public facts.** The relayed-request map stores each request's
   coordinates, kind, and question. The task table stores calls and outcomes. Approval
   candidates store settlements. Each copy is parsed, validated, and closed by hand: relayed
   requests at five sites, sign-ins at three plus supersession.
3. **A record tracks whether its events went out.** Approval candidates carry `eventEmitted` and
   `pendingEventEmitted` flags. The tool loop emits every unmarked entry, then marks it.
4. **Readers re-derive from raw events.** The message reducer folds a second call lifecycle into
   `part.state`. `agentCallTurns` assigns a child session's turns to calls by counting messages.
5. **Status is inferred from shape.** The handoff idle check reads three turn-state fields and
   probes two raw keys. Nothing writes one of them, `eve.harness.pendingWorkflowInterrupt`.

The stack fixes bugs of these kinds, among others:

- Cancelling a task left its relayed requests open and routable.
- A finishing workflow run dropped its questions without an event.
- `respond(A)` stopped at a boundary that belonged to a sibling answer.
- `clear` left approvals answerable.

## Proposal

### Four kinds of state

Every durable piece of session state is exactly one of these:

| Kind           | What                                                                                                                        | Written by                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Machine state  | `TurnState`: the open turn and its deliveries, parked calls and their approvals, the prompt, queued input, grants, sequence | The turn state module only                 |
| Projection     | `SessionProjection`: turns, inputs, tasks, calls, sign-ins                                                                  | Folding the events the machine publishes   |
| Private record | What readers never see, keyed by an ID the machine or projection tracks: routes, callbacks, run addresses                   | The machine; dropped when its owner closes |
| Cache          | A derived value for a reader that cannot load the session, such as `hasProxyInputRequests`                                  | One function, when the session is saved    |

A record with its own status, or a flag recording whether an event went out, is none of these.

```
          ┌──────────────── turn state module ────────────────┐
input ───▶│  transition(state, input) → { state, events }     │
          └────────┬───────────────────────────────┬──────────┘
                   ▼                               ▼
     TurnState + private records          events ──▶ stream ──▶ client fold
                                              │
                                              ▼
                                   stored SessionProjection ──▶ activity, idle check, task cards
```

### Invariants

1. Only the turn state module writes `TurnState` and builds lifecycle events. Callers publish
   what a transition returns.
2. The projection is the fold of published events, the session's own and relayed ones. It is
   stored with the step that published them.
3. A private record exists only while turn state or the projection shows its owner open.
   Closing the owner means emitting its event, and the record is dropped with it.
4. A lifecycle question has one answer: the projection's. Turn state answers only what the
   stream does not carry, such as which calls wait to dispatch.
5. Caches are computed in the save function.

`pnpm guard:invariants` enforces the first two mechanically. The check fails if code outside the
module imports turn-state writers or lifecycle event constructors, or if code outside the emit
path writes the projection.

### Server records

| Record                                                 | Public part, read from the projection                                                   | Private part that remains                                                          | Notes                                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Relayed requests (`eve.runtime.proxyInputRequests`)    | open or closed, kind, coordinates, question, `callId`                                   | route: child continuation token and inbox, remote binding, workflow-ask route, run | `hasProxyInputRequests` becomes "an open input with a route"                        |
| Pending sign-ins (`eve.runtime.pendingAuthorization`)  | open or closed, name, `callIds`, coordinates                                            | callback URL, resume value, principal, connection instance, approval candidate     | Superseding an attempt emits `authorization.completed` with `failed`                |
| Task table (`eve.taskTable`)                           | name, kind, calls and their outcomes                                                    | run address, commands held for the run, usage, `resumable`                         | Results waiting for the model are pending work and move into turn state             |
| Approval candidates (`eve.runtime.hitl.approvalState`) | settlements, which duplicate turn state's decisions and the projection's input outcomes | responder progress: candidate, expiry, sign-in challenges                          | Transitions return `approval.candidate` and `approval.settled` events; the flags go |
| `TurnDeliveryIdsKey`                                   | none                                                                                    | none                                                                               | Moves into `TurnState.turn`                                                         |
| `eve.harness.pendingWorkflowInterrupt`                 | none                                                                                    | none                                                                               | Nothing writes it; delete it                                                        |
| Session-limit prompt                                   | open or closed, and its request                                                         | none                                                                               |                                                                                     |
| Channel activity (`eve.activitySessionProjection`)     | everything it shows                                                                     | none                                                                               | Its own key and mapping go                                                          |
| Handoff idle check                                     | open turns, inputs, and sign-ins                                                        | none                                                                               | One `isIdle` predicate in the turn state module, instead of probing keys            |

The projection is folded on every event, not only when an activity observer is attached, and it
includes relayed events. Its pruning must be bounded before it is stored in every session.
`retainOpenWork` currently keeps every turn that continues another, so a long-lived session's
projection grows without limit.

### Clients and eve's other readers

Clients already fold the same `SessionProjection` inside `ConversationState`. The remaining
work removes the other derivations.

- **Message reducer.** It keeps content (text, reasoning, tool input and output). It writes
  `part.state` from the call's projection status:

  | Projection status                                 | `part.state`                                                  |
  | ------------------------------------------------- | ------------------------------------------------------------- |
  | `running`                                         | `input-available`, or `output-available` with `partial: true` |
  | `awaiting-input`                                  | `approval-requested`                                          |
  | `completed`                                       | `output-available`                                            |
  | `failed`, `cancelled`, `interrupted` (turn ended) | `output-error`, with `errorText` saying why                   |
  | `rejected`                                        | `output-denied`                                               |

  `output-error` also covers calls eve stopped; `toolCallState` tells stopped calls from failed
  ones. A call interrupted because the reader's stream stopped remains a read-time judgment,
  passed as `streaming`.

- **`toolCallState(conversation, callId, { streaming })`.** It reads status from the projection
  and content from the canonical part. The store always keeps the canonical `conversation`
  beside a custom reducer's `data`, so custom reducers are unaffected and the part fallback
  goes.
- **Reads and store status.** `ClientSession` reads and `EveAgentStore` status become checks
  against the projection and delivery facts. Sends not yet accepted, HTTP errors, and aborts
  stay local.
- **Agent calls.** The parent states each call's delivery ID to its child session, and the child
  stamps its events with the deliveries it serves. A call's child turns are the turns stamped
  with its delivery. This replaces counting messages.
- **Evals and ACP.** `derive-run-facts` and the ACP adapter fold the projection. ACP stops
  reporting rejected and cancelled calls as failed.

These are public behavior changes, and each ships with a changeset and docs. Instrumentation,
tracing, and channel adapters' own event handlers are out of scope.

### Compatibility

Sessions are not ported, which follows existing practice:

- The session checkpoint version went from 4 to 10 between #3263 and #3970. #3970's changeset
  tells users to keep each session's owning deployment available until the session finishes.
- Since #4032, an incompatible handoff leaves the session on its current owner.
- On Vercel, old sessions keep running old code. Since #3817, sessions park after each turn
  instead of ending, so an old deployment may serve a thread indefinitely.
- Local and in-place upgrades have no old code to keep. The next delivery fails with
  `Unsupported session checkpoint. Start a new session on this deployment.`

The stream needs one addition. `x-eve-stream-version` reports the serving deployment's version.
The events come from shared storage, and an older owner may have written them.

A v27 client filters `respond()` by its answer's delivery ID, and events from a v26 owner never
carry that ID. We expect such a read to hang; this has not been reproduced across deployments
yet. Each event should carry its writer's version, and version-dependent reading should key off
it. That includes the `respond()` filter and the projection's inference for older streams. The
projection keeps that inference until eve sets a floor for the writer versions it reads.

### Longer term: a decider

In this design, effects stay inline. The turn state module decides, and its callers run
policies, tools, and model calls between transitions.

A decider goes further. `decide(state, input)` returns events and effects, `evolve(state, event)`
returns the next state, and a runtime executes the effects. Turn state would change only by
applying events, and the projection would be `evolve` restricted to public facts. Transitions
could be tested without a runtime.

The cost is in the pending-work path, which interleaves decisions with user code: response
policies, connection authorization, approved tool runs, and sandbox staging. The steps below
are a subset of this shape, so none of them is wasted. The approval coordinator is the slice to
prototype before deciding.

### Sequencing

Each step lands as its own PR and passes on its own. This order follows the first four stack
PRs (#3878, #3879, #3880, #3965):

1. **Extract `SessionProjection`** from the client fold, with its meaning unchanged.
2. **Turn state with the machine module.** This reshapes #4018 and includes:
   - delivery IDs and approval candidates moving into turn state;
   - the idle predicate and the guards;
   - deleting the interrupt key;
   - folding and storing the projection on every event, with bounded pruning;
   - deriving the prompt;
   - the stream checker and generated sessions.
3. **Sign-ins:** stated facts and derived pending sign-ins.
4. **Relayed requests:** withdrawals, coordinates, and the derived route map.
5. **Tasks:** the task table splits into projection, turn state, and private runs.
6. **Remaining stream facts:** turn relations, `cancelled` and `rejected` statuses, and delivery
   attribution with writer versions.
7. **Channel activity** reads the stored projection.
8. **Clients:** selectors, `part.state`, reads and store status, then evals, ACP, and the web
   template.

The stream version changes once, with the first step that changes a meaning. Step 4 is the
best first prototype: it is the largest single deletion, and it covers a class of bug the stream
checker found.

### Expected size

These are rough estimates from file sizes, not measurements. Server production code shrinks by
about 450–850 lines and client code by about 400–700, on top of the stack's current net −720.
Three things could shrink the saving:

- the inference retained for older writers;
- private data that turns out larger than expected;
- projection fields that only the server needs.

The relayed-request prototype will calibrate these estimates.

## Open questions

- Approval candidates' audit history also guards candidate-ID uniqueness and duplicate
  responses. Can turn state and the projection answer both?
- The task table's idle, resumable tasks feed the model's `[Tasks]` note. Should that listing
  read the projection, turn state, or a private record?
- Should the writer version go on every event or on each turn?
- Which writer versions should clients stop reading, and when?
- Should the parent stream state the agent-call relation, or should a selector read the parent's
  and child's state together?
- Instrumentation scope records (`instrumentationInputScopes`, `instrumentationActionScopes`) are
  private data keyed by requests and calls. Are they dropped when their owners close?
- #4028's `TaskCardView` should read the stored projection, with row identity and status
  vocabulary that match it.
