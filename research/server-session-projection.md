---
issue: "None (maintainer-requested research)"
status: proposed
last_updated: "2026-09-30"
---

# Server-side session projection

eve keeps two records of a session's lifecycle. The harness's
[turn state](./turn-state.md) is the source of truth, and it emits the
session's events. `SessionProjection`, from the
[stream contract](./session-stream-contract.md), folds those events back into
turns, calls, requests, tasks, and sign-ins for the client and for channel
activity. Tests hold the two in agreement through the checker's
`state-agreement` rule. Nothing else does.

This note proposes that the server fold its own stream into the same
projection and answer lifecycle questions from it. Private execution data
stays in a separate record. It is a follow-up to the stream contract and
turn state work, not part of it.

## Why the projection can't be the whole state

- **It holds only what readers need.** The server also needs data that can't
  or shouldn't reach the stream: exact model messages with provider metadata,
  tool inputs and dynamic-tool closures for replay, the routes to child
  sessions, workflow runs, and remote agents (continuation tokens and inbox
  addresses), `once()` grants, and runtime dispatch bookkeeping.
- **The server needs finer states than the stream reports.** A parked call is
  `awaiting-approval`, `approved`, `ready`, `running`, or `settled`, and a
  parked step records whether it can resume. The projection has `running`,
  `awaiting-input`, and settled outcomes. Stating the rest would put
  internals on the public protocol.
- **The stream isn't an exact log of committed state.** A retried step
  re-emits its events, and a cancelled step commits the state it started
  from after emitting events. A fold that commits with its step stays
  correct; the stream's readers still see what the discarded attempt emitted.
- **The event schema would become the durable-state schema.** Every internal
  change would become a protocol change plus a session migration.

## Proposal

The server folds every event it publishes, its own and relayed, into a
`SessionProjection` that it stores with the step. Lifecycle questions that
readers also ask are answered from that projection:

- which requests are open, and which call or task each belongs to;
- which sign-ins are pending, and which calls they stop;
- whether a turn is active, and which turn a resumed one continues;
- each call's status.

A private execution record, keyed by the same `callId`, `requestId`, and
`attemptId`, holds the rest: parked steps and their finer call states,
routing, closures, and grants.

```
harness decision ─► emit(event) ─┬─► stream ─► clients, channel activity
                                 └─► fold ─► SessionProjection (stored with step)
                                               ▲
harness ─► execution record ──(keyed by id)────┘
```

### Invariants

- **Events are the only writer.** The server changes whether a request,
  sign-in, call, or turn is open only by emitting the event that says so.
- **The stored projection is the fold of what the committing attempt
  emitted.** A retried step folds again from the state it was given.
- **Execution entries follow the projection.** An entry exists only while
  the projection shows its request, sign-in, or call open, and goes when it
  settles.
- **Private data never enters an event.**

### What changes

- **Nothing on the stream.** The work is internal.
- **Duplicated records become derived.** The open set of pending sign-ins,
  the open part of the relayed-request map, and whether the session-limit
  prompt is open come from the projection; only their routing and closures
  stay private. `state-agreement` stops applying to what is derived.
- **Channel handlers can read the session.** An adapter today sees events one
  at a time and keeps what it needs in its own `state`. The projection it runs
  beside could be exposed read-only on its context, giving every channel
  the root session's `ConversationState`-like view. This is a public
  authoring API and needs its own proposal for naming and shape.

### What it doesn't fix

- **A cancel after a step reported progress.** A workflow step commits
  atomically, so a projection stored with the step is discarded with it, as
  the turn state is.
- **Child progress on the server.** A root session sees its children only
  through relayed requests and task settlement. A full child view needs the
  server to follow child streams, which it doesn't.

## Staging

1. **Fold on every emit.** Today the fold runs only when an activity observer
   is attached, and only over the session's own events. Always fold, over
   own and relayed events, pruned to open work, and store it with the step.
   Channel activity, and a task card built on it, read it instead of seeding
   their own.
2. **Derive one record.** Move pending sign-ins' open set onto the
   projection, keep their routing private, and drop `state-agreement` for
   them. This tests the invariants on a small surface.
3. **Decide on the rest** from what step 2 shows: the relayed-request map,
   the prompt, and whether any call status in the turn state can be read
   from the projection instead of stored.
4. **Propose the channel handler view** once the projection's stored shape is
   stable.

## Open questions

- **Size.** The pruned projection keeps every turn a continuation still
  reaches, indefinitely. Storing it with every step may need tighter pruning.
- **Relayed events.** The client's projection folds relayed requests with
  their `callId`. The server's fold must match exactly, or clients and
  channels disagree about what is open.
- **Retries.** The fold is keyed by call, request, and attempt IDs, so an
  event a retry emits again mostly lands on the same entry. A retried step
  that emits a different sequence needs a test.
