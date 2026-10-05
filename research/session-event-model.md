---
issue: "None (maintainer-requested research)"
status: draft
last_updated: "2026-10-05"
---

# Session event model

## Summary

Every eve reader folds the same session stream: web and React clients, the dev TUI, Slack and Teams, evals, ACP, authored hooks, channels, and dynamic resolvers. Understanding that stream takes more than `protocol/message.ts`:

- an approval's outcome is spread across three events;
- a tool's receipt is easy to read as its outcome;
- response completion is inferred from turn boundaries;
- most payloads repeat `turnId`, `sequence`, and `stepIndex`, and what those mean depends on the event.

This doc proposes the contract for the next deliberate stream-version break:

- **Eight entities.** Each has one ID, one owner declared when it is introduced, and exactly one terminal event with an outcome specific to that entity.
- **Invariants a checker enforces.** A reader can tell what happened, to which entity, and who owns it, without special cases.
- **Explicit facts for what readers guess today:** when a delivery's response is finished, what a call returned to the model versus how its work ended, and how an interaction was resolved.
- **A reshaped shared projection.** Its fold updates one table per event family, and clients read it through selectors.

The catalog has 28 event types, 26 durable facts and 2 streaming progress types, where v26 has 34. Fewer names is a side effect, not the goal.

## Baseline and scope

This builds on the session-state stack (#4177, #4178, the planned approved-execution PR, #4141, #4142, #4143) and its research doc, #4067. That stack gives eve:

- one fold over published events (`foldSession`);
- transitions that are the only builders of lifecycle events;
- one commit order: publish, fold, run hooks, save.

The stack is narrowing to stream v26 and deferring four changes. Each one would patch v26 vocabulary that this contract replaces, so they land here as families of one contract:

| Deferred from the stack                            | Lands here as                                |
| -------------------------------------------------- | -------------------------------------------- |
| Complete each response at its delivery's boundary  | Delivery facts and the finish rule           |
| Precise outcomes for stopped calls                 | `call.settled` outcomes and explicit closure |
| Evals that distinguish receipts from work outcomes | `call.returned` versus `call.settled`        |
| Owner versus origin for relayed requests           | `interaction.opened` `subject` and `origin`  |

Nothing here widens the stack. Execution machinery, HITL authorization rules, and storage are out of scope; [Private state](#private-state) covers only the boundary.

## What readers guess today

| Readers guess                            | Example                                                                                                                                                                                                                                               | Rule that removes the guess                                    |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A call's status, from six event types    | In the shared fold (#4141), `approval.settled` uses `cancelled` for a responder's decline, so HTTP denials read as withdrawals. `input.resolved` settled a call before the `action.result` that carried the denial reason, so ACP dropped the reason. | One terminal per entity; no fold case changes a second entity  |
| A work outcome, from the model's receipt | Evals count a task call `completed` from its receipt even when the task was cancelled. `noFailedActions` reads `isError`.                                                                                                                             | `call.returned` and `call.settled` are separate facts          |
| A response's end, from turn boundaries   | `respond()` keeps a first-boundary fallback, because answers routed through tools, workflows, and child sessions publish outside the turn step and lose `meta.deliveryIds`.                                                                           | Deliveries are entities with a terminal                        |
| Queued versus received                   | A message held behind the budget prompt needed an "announced?" flag.                                                                                                                                                                                  | `delivery.accepted` and `delivery.consumed` are separate facts |
| An entity nobody introduced              | A resumed approved call's result arrived with no prior request, so readers named the call from the result.                                                                                                                                            | Introduce before reference                                     |
| An ending nobody recorded                | A call still running when its turn is cancelled reads `interrupted` by inference, so pruning never drops it. `context.cleared` has no fold case.                                                                                                      | Owners close their children explicitly                         |
| What coordinates mean                    | `main` relays a child's request at the child's turn and step; the stack's first version moved it to the parent's serving call. Both are reasonable, but one field can't carry both meanings.                                                          | Typed `subject` and `origin`                                   |

## Entities and invariants

| Entity       | Meaning                                             | Owner, declared at introduction                   |
| ------------ | --------------------------------------------------- | ------------------------------------------------- |
| Session      | Durable conversation and its ongoing work           | Parent call, when delegated                       |
| Delivery     | One submitted message, answer, or control request   | Session                                           |
| Turn         | Agent work that can pause and resume                | Session; caused by a delivery or callback         |
| Model run    | One logical model invocation                        | Turn                                              |
| Content part | One identifiable piece of user or assistant content | Delivery (user) or model run (assistant)          |
| Call         | One invocation of a tool, agent, or skill           | Model run, or parent call when nested             |
| Task         | Work that outlives an immediate return              | The call that started it; it can outlive its turn |
| Interaction  | An approval, question, sign-in, or budget prompt    | Subject: a call, task, or turn                    |

When a call or task opens a child session, the parent records it as a link (`child.opened`). The child's lifecycle lives in its own stream.

```text
Session
├─ Delivery ──consumed into──▶ Turn
│    └─ Content part (user)
├─ Turn (cause: delivery)
│    └─ Model run (purpose: respond | compact)
│         ├─ Content part (assistant)
│         └─ Call ──delegated to──▶ Task
│              ├─ Call (nested)
│              └─ Interaction (approval) ──settled by──▶ Delivery
└─ Task (can outlive turns)
     ├─ Interaction (question, sign-in)
     └─ Child session link
```

Invariants:

1. **One entity per fact.** A fact's type names its entity family, and its payload carries that entity's ID. Each fold case updates one table.
2. **Introduce before reference.** An entity ID appears in another fact only after the fact that introduces it. An entity's owner never changes.
3. **Exactly one terminal.** Each entity has one terminal event type, with an outcome specific to that entity. A person can decline an interaction; a model run can't be declined. The fold ignores a second terminal.
4. **Explicit closure.** When the machine ends an owner, it emits terminals for the children it ends, in the same commit and before the owner's terminal. Tasks, and interactions that belong to tasks, are declared to outlive turns.
5. **Decisions, not inferences.** A fact records a machine decision or an accepted observation. No reader derives lifecycle from output text, `isError`, or a missing event.
6. **Joins are selectors.** State that spans entities, such as a call awaiting input or an idle session, is computed, not stored. A machine decision is still a fact even when it could be derived: `turn.paused` records that the machine parked.
7. **Progress is bounded by its owner.** Deltas never enter the lifecycle fold. A completion fact replaces them, and the owner's terminal abandons any that never completed.
8. **References, not internals.** Facts carry eve-owned IDs and resource references. They never carry secrets, workflow or node IDs, credential resolver keys, or dispatch variants.
9. **Transitions are the only writers.** Every fact comes from one transition's output, and one transition is one commit.

A stream checker enforces invariants 2–4 over test streams. Each family module declares `{ idField, introducedBy, terminal, owner }`, so the checker, the event reference docs, and pruning can all be generic. That descriptor is metadata, not a state-machine language.

There are three kinds of records:

|             | Facts                                | Progress                         | Private records                                 |
| ----------- | ------------------------------------ | -------------------------------- | ----------------------------------------------- |
| Examples    | `call.settled`, `interaction.opened` | `content.delta`, `call.progress` | Suspended steps, answer routes, grants, history |
| On the wire | Yes                                  | Yes                              | Never                                           |
| Folded into | The shared projection                | Nothing                          | Execution state                                 |
| In a commit | Yes                                  | No; streamed between commits     | Yes                                             |

## Event catalog

```text
envelope: { id, sessionId, at, type, data }       cursor: stream position (transport)

ENTITY         INTRODUCED BY        NON-TERMINAL                       TERMINAL
Session        session.started      —                                  session.closed
Delivery       delivery.accepted    delivery.consumed                  delivery.finished
Turn           turn.started         turn.paused · turn.resumed         turn.settled
Model run      model.started        —                                  model.settled
Content part   content.started      content.delta~                     content.completed
Call           call.requested       call.returned · call.delegated     call.settled
                                    call.progress~
Task           task.started         —                                  task.ended
Interaction    interaction.opened   —                                  interaction.settled
 └ attempt     attempt.opened       —                                  attempt.settled
Child session  child.opened         —                                  (in the child's stream)
Context        —                    context.compacted · context.cleared

~ streaming progress. content.completed may introduce a part that never streamed.
```

Each v26 event maps to the catalog like this:

```text
v26                              PROPOSED
session.started ───────────────▶ session.started        parent: {sessionId, callId}
session.completed ─┬───────────▶ session.closed         {completed | failed}
session.failed ────┘
session.waiting ───────────────▶ ✕ idle is a selector; a response ends at delivery.finished;
                                   continuationToken → session resource; usage → selector
(meta.deliveryIds) ────────────▶ delivery.accepted · delivery.consumed · delivery.finished
message.received ──────────────▶ delivery.consumed + content.completed (owner: delivery)

turn.started ──────────────────▶ turn.started           {cause}; no sequence
turn.waiting ──────────────────▶ turn.paused            {awaiting: refs}
(next step.started) ───────────▶ turn.resumed           {cause}
turn.completed ─┐
turn.failed ────┼──────────────▶ turn.settled           {completed | failed | cancelled}
turn.cancelled ─┘

step.started ──────────────────▶ model.started          {runId, purpose: respond}
step.completed ─┬──────────────▶ model.settled          {outcome, finishReason, usage}
step.failed ────┘
compaction.requested ──────────▶ model.started          {purpose: compact}
compaction.completed ──────────▶ model.settled + context.compacted
context.cleared ───────────────▶ context.cleared

message.appended ──────┐
reasoning.appended ────┼───────▶ content.started + content.delta     {kind}
action.input.appended ─┘
message.completed ───┐
reasoning.completed ─┼─────────▶ content.completed                   {kind}
result.completed ────┘

actions.requested ─────────────▶ call.requested         one per call; capability, not dispatch
action.partial ────────────────▶ call.progress
action.result ─────────────────▶ call.returned + call.settled
task.started ──────────────────▶ task.started (once) + call.delegated (per call)
task.settled ──────────────────▶ call.settled (+ task.ended when the task stops)
agent.started ─────────────────▶ child.opened           resolver key → private

input.requested ─────────┐
authorization.required ──┴─────▶ interaction.opened     {kind: approval | question | budget | sign-in}
input.resolved ──────────┐
approval.settled ────────┼─────▶ interaction.settled    one terminal; outcome by kind
authorization.completed ─┘
approval.candidate ────────────▶ attempt.opened · attempt.settled
```

## Semantics

### Calls

```text
call.requested  { callId, owner: {runId} | {callId}, capability: {kind, name}, input }
call.returned   { callId, output, isError? }          what entered model history
call.delegated  { callId, taskId }                    a task serves this call
call.settled    { callId, outcome, error?, usage? }   the authoritative verdict
```

- A synchronous call emits `returned` and `settled` in one commit. Conversation views read `returned`. Activity views, ACP, and evals read `settled`.
- Outcomes are:
  - `completed`;
  - `failed`, for an execution error;
  - `rejected`, with `by: interaction | policy`;
  - `interrupted`, with a reason such as `turn-cancelled`, `context-cleared`, `authorization-required`, or `attempt-abandoned`.
- A call that needs a sign-in settles as `interrupted` with reason `authorization-required`, and the sign-in interaction names it as its subject. When the model retries, that's a new call.
- `capability.kind` is `tool`, `agent`, or `skill`. Whether a call runs inline, as a workflow, remotely, or at the provider is a private execution plan.
- A task call returns its receipt at once. It settles when the task finishes serving it, which is when `task.settled` fires today. `task.started` fires once per task. `task.ended` fires when the task itself stops, which for a `serve` task can be many calls later.

### Interactions

```text
interaction.opened  { interactionId, subject, request: {kind, ...}, audience?, origin? }
interaction.settled { interactionId, outcome, by?: {deliveryId} | {callback} | {policy}, response? }
```

| Kind     | Outcomes                                         |
| -------- | ------------------------------------------------ |
| approval | approved, declined, withdrawn, expired           |
| question | answered, withdrawn, expired                     |
| sign-in  | authorized, declined, failed, withdrawn, expired |
| budget   | granted, declined, withdrawn                     |

`withdrawn` carries a reason: `turn-cancelled`, `context-cleared`, `superseded-by-message`, or `owner-ended`.

- Resolving an approval never settles its call by inference. One transition emits both `interaction.settled` (declined) and `call.settled` (rejected, `by: interaction`).
- Responder candidates and repeated sign-in attempts are subordinate `attempt` entities. Only `interaction.settled` settles an interaction.
- An answer is stale only if a different delivery already settled its interaction. Batches of approvals stay private, and each interaction settles on its own.
- `audience` scopes a sensitive request to one principal. Instead of the challenge itself, the fact carries a reference that trusted channel code dereferences after an authorization check.
- The held-turn behavior in [`held-sign-in-and-approval.md`](./held-sign-in-and-approval.md) carries over unchanged. Only how it is reported changes.

### Deliveries

```text
delivery.accepted  { deliveryId, kind: message | answer | control, principal? }
delivery.consumed  { deliveryId, turnId }        a message entered the conversation
delivery.finished  { deliveryId, outcome: settled | paused | applied | forwarded | ignored | failed }
```

HTTP enqueue stays a transport acknowledgement that carries the `deliveryId`, as in [`accepted-message-correlation.md`](./accepted-message-correlation.md). The stream starts at driver acceptance, so the queue is a selector: accepted messages not yet consumed.

**Finish rule.** A delivery finishes when the session can make no further progress on its behalf without another delivery, or when the work it joined settles.

- A pause for an answer finishes the delivery. The answer arrives as its own delivery and owns what follows.
- A pause on tasks or on a sign-in callback doesn't finish it. The continuation still belongs to this delivery, as it does for `TurnSegment` readers today.
- Callbacks are accepted observations (`by: {callback}`), not deliveries.
- An answer routed to a child session or workflow can finish as `forwarded`, naming the child's `deliveryId`. A reader that wants the continuation follows the child.

`ClientSession.send()` and `respond()` read until their delivery's `delivery.finished`. The finish rule is computable only if every consumption happens in a transition, including answers routed through tools, workflows, and relays.

### Turns and model runs

- `turn.paused { awaiting }` records that the machine parked, with references to the interactions or work it waits on. Whether it waits on a person is a selector over those references, so today's `on: "input" | "tasks"` becomes derived.
- `turn.resumed { cause }` becomes necessary once eve runs approved calls before the next model call. Today the next `step.started` is the only resume signal.
- Model runs have IDs. `stepIndex` and `sequence` disappear from payloads.
- Compaction is a model run with `purpose: "compact"`, so its usage is attributable. `context.compacted` records the range it replaced.
- A retried model call is a new run. The abandoned run and its calls get terminals once the machine sees them (see [Envelope, identity, and ordering](#envelope-identity-and-ordering)).

### Content

- Kinds are:
  - `text`;
  - `reasoning`, only what the provider exposes;
  - `structured`, today's `result.completed`;
  - `call-input`, provisional until `call.requested`.
- User parts belong to their delivery and are the canonical structured message; the flattened `message` string goes away. Assistant parts belong to their model run. `finishReason` moves to `model.settled`.
- Deltas follow [`delta-text-streams.md`](./delta-text-streams.md): plain deltas, accumulated in order. `content.completed` replaces the accumulated value.

### Usage

- A session's own usage appears only on `model.settled`, including compaction runs.
- Delegated usage appears only on the settlement of the agent call or task.
- Totals are a projection. Usage stamped on `turn.waiting`, `session.waiting`, and `session.failed` goes away.
- A parent counts a child's usage once, through that settlement.

### Child sessions and relays

`agent.started` becomes `child.opened { sessionId, owner: {callId} | {taskId}, name, stream }`. The remote credential resolver key becomes private. A child's question becomes a parent interaction:

```text
interaction.opened {
  interactionId,
  subject: { callId },                      the parent's serving call
  origin:  { sessionId, interactionId },    the child's request
  request
}
```

The parent stream contains only parent entities, so the envelope's `sessionId` always names the stream's own session. Answer routing is a private record keyed by the parent interaction.

## Example: a declined approval

Today, when a responder declines over HTTP:

```text
step.started       {turnId, sequence, stepIndex: 1}
actions.requested  {actions: [{callId: c1, kind: "tool-call", toolName: "deploy"}], …}
input.requested    {requests: [{kind: "tool-approval", action: {callId: c1}}], …}
step.completed     {finishReason: "tool-calls", usage, …}
turn.waiting       {on: "input", usage, …}
                   ── answer arrives; linked only through meta.deliveryIds ──
approval.settled   {outcome: "cancelled"}                ← means "declined"
input.resolved     {resolutions: [{outcome: "denied"}]}  ← settles c1 by inference
action.result      {status: "rejected", error, result}   ← a third word on c1's status
step.started       {stepIndex: 2}                        ← the only resume signal
```

Proposed:

```text
model.started       {runId: r1, turnId: t1}
call.requested      {callId: c1, owner: {runId: r1}, capability: {kind: "tool", name: "deploy"}}
interaction.opened  {interactionId: i1, subject: {callId: c1}, request: {kind: "approval"}}
model.settled       {runId: r1, outcome: "completed", finishReason: "tool-calls", usage}
turn.paused         {turnId: t1, awaiting: [{interactionId: i1}]}
delivery.finished   {deliveryId: d1, outcome: "paused"}
                    ── answer ──
delivery.accepted   {deliveryId: d2, kind: "answer"}
interaction.settled {interactionId: i1, outcome: "declined", by: {deliveryId: d2}}
call.returned       {callId: c1, output: "…denied…"}               ← what the model reads
call.settled        {callId: c1, outcome: "rejected", by: {interactionId: i1}}
turn.resumed        {turnId: t1, cause: {deliveryId: d2}}
model.started       {runId: r2, turnId: t1}
```

## Envelope, identity, and ordering

```ts
{
  (id, sessionId, at, type, data);
}
```

- **The cursor orders; `at` only informs.** Readers resume from a stream position, and timestamps carry no ordering.
- **Event IDs identify writes.** A retried workflow step re-emits its events under new IDs, and its model output may differ. The contract states the consequence: for each entity, folds keep the first introduction and the first terminal. Deterministic IDs are feasible only for facts whose content is fixed by durable inputs, which excludes model output.
- **Snapshots carry their position.** The server saves the projection together with the stream position it reflects. On restore it folds from that position to the tail, so the machine sees facts a crashed attempt published and can close them. Clients that join mid-stream read a snapshot plus a cursor instead of relying on self-contained events.
- **Commit grouping is optional.** Facts from one commit can share a commit ID if a client needs to apply them atomically.

## Session projection

The v26 shape, as of #4141 (the narrowed stack drops `callIds` and the `cancelled` call result):

```text
SessionProjection
├─ started?  ended?
├─ activeTurnId?   nextSequence
├─ turns          [turnId]       sequence · status · waiting? · stepIndex · stepStarted? · outputStarted?
├─ calls          [callId]       name · turnId · stepIndex · status · requestId? · taskId? · error?
├─ tasks          [taskId]       name · kind · calls[callId] { turnId · status · output? · error? }
├─ inputs         [requestId]    request · sequence · turnId · stepIndex · taskId? · callId?
│                                status: open | responded* | settled · response? · outcome?
├─ authorizations [attemptId]    name · sequence · turnId · stepIndex · taskId? · principalId?
│                                candidateId? · callIds? · status · awaitsCallback?
└─ candidates     [candidateId]  requestId · outcome

* a client-only status stored in the shared type
```

Proposed:

```text
SessionProjection @ position
├─ session        status: open | completed | failed · parent?
├─ activeTurnId?                          an index the turn facts keep current
├─ deliveries     [deliveryId]     kind · principal? · status: accepted | consumed | finished
│                                  turnId? · outcome?
├─ turns          [turnId]         cause · status: active | paused | completed | failed | cancelled
│                                  awaiting?
├─ runs           [runId]          turnId · purpose · model · status · finishReason? · usage?
├─ parts          [partId]         owner · kind · status     (no text; text lives in the conversation view)
├─ calls          [callId]         owner · capability · returned? · taskId?
│                                  status: open | settled · outcome?
├─ tasks          [taskId]         startedBy · kind · name · status: running | ended · outcome?
├─ interactions   [interactionId]  kind · subject · origin? · audience? · status: open | settled
│                                  outcome? · by? · attempts[attemptId] { principalId · outcome? }
└─ children       [sessionId]      owner · name · stream
```

| Removed                                                | Replaced by                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `sequence`, `stepIndex`, `stepStarted`, `nextSequence` | Entity IDs and stream order                                         |
| `turns.waiting`                                        | `turns.status: "paused"` with `awaiting`                            |
| `calls.status: "awaiting-input"`, `calls.requestId`    | Selector: an open interaction whose subject is the call             |
| `interrupted` inferred when a turn ends                | An explicit `call.settled` outcome                                  |
| `tasks[].calls`                                        | `calls[].taskId` and `call.settled`; tasks keep their own lifecycle |
| `inputs`, `authorizations`, `candidates`               | `interactions` with `attempts`                                      |
| `inputs.status: "responded"`                           | A client overlay outside the shared fold                            |
| `started`, `ended`                                     | `session.status`                                                    |

New: `position` (restore catch-up and mid-stream readers), `deliveries` (response completion and the queue), `runs` and `parts` (model-run identity, with `outputStarted` as a selector), and `children`.

| Selector           | v26                                     | Proposed                                           |
| ------------------ | --------------------------------------- | -------------------------------------------------- |
| `callStatus(c)`    | Stored status plus turn-ended inference | `open` or `settled`, joined with open interactions |
| `turnWaitingOn(t)` | `turn.waiting.on`, which the fold drops | Kinds of the turn's `awaiting` references          |
| `idle`             | Derived from `session.waiting`          | No active turn and no unconsumed deliveries        |
| `queuedInput`      | Private execution state                 | Accepted, unconsumed deliveries                    |
| `deliveryDone(d)`  | Client inference (`TurnSegment`)        | `deliveries[d].status === "finished"`              |
| `usage`            | Stamped on waiting and terminal events  | Sum of `runs` usage plus delegated settlements     |

Pruning becomes generic: drop settled entities that no open entity references, following the owner links declared by each family. Today it is hand-written per table, takes `keep` sets from execution state, and keeps interrupted calls forever.

**Public surface.** In #4143, `ConversationState` extends `SessionProjection` and exports its record types, so every table change above becomes a public break. Clients should hold the projection as one field and read it through selectors: `toolCallState`, `openConversationInputs`, and the selectors above.

## Authoring API impact

| Surface                                    | Today                                                                           | Proposed                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `defineHook({ events })`, channel `events` | v26 event names                                                                 | Catalog names; `HookEventMap` stays an explicit map, so aliases are possible where a mapping is one-to-one |
| Hook and handler context                   | Self-contained events                                                           | `ctx.view`: the projection as of the fact                                                                  |
| `defineDynamic({ events })`                | `session.started`, `turn.started`, `step.started`                               | `session.started` and `turn.started` keep their names; `step.started` becomes `model.started`              |
| Evals                                      | `turn.event()` with v26 names; `calledTool` and `noFailedActions` read receipts | Catalog names; outcomes come from `call.settled`                                                           |
| `ClientSession.send()`, `respond()`        | Inferred from segment boundaries                                                | Read until `delivery.finished`                                                                             |
| `ConversationState`                        | Extends the projection (#4143)                                                  | A projection field plus selectors                                                                          |

Dynamic resolvers are participants, not observers. The machine invokes them before it decides and records what they returned, so a restore doesn't re-resolve against today's configuration. Their keys name resolution points, which happen to share names with facts. Hooks and channel handlers observe facts and can't change a commit; `ctx.cancel()` becomes a control input to the next transition.

## Private state

Some records never go on the wire:

- withheld model responses;
- prepared tool inputs;
- answer routes;
- approval grants;
- sign-in challenges and resume data;
- execution plans;
- history.

The session-state stack already writes most of these only from transitions. Whether they should become an appended journal instead of snapshots is a separate decision that needs its own measurements. This contract doesn't depend on that decision, but its facts are shaped to allow it: each fact is one decision, and the stream is exactly the facts of each commit, in commit order.

## Compatibility and rollout

One stream-version break, after the session-state stack merges, landed as one stack in this order:

1. **Contract module and envelope.** Wire types separate from runtime types, so `RuntimeActionRequest` dispatch fields become `capability`. No semantic change.
2. **IDs and ownership.** Run and part IDs, owners declared at introduction, no coordinate bag, and the snapshot position.
3. **Calls and tasks.** This removes the most fold special cases and changes eval semantics.
4. **Interactions.** Contained behind the `hitl/` boundary.
5. **Deliveries.** These need `interaction.settled.by`, and every publication path running through transitions.
6. **Content.** Independent of the rest; it can move earlier.

For sessions that predate the break, either refuse stream rewinds into them, or add one legacy upcaster that holds today's inference rules until v26 support ends. Either way, the shared fold never learns v26. Extension contract epochs regenerate from the catalog.

## Non-goals

- A generic `entity.updated` or patch event.
- Self-contained events; a snapshot plus a cursor replaces them.
- Publishing private records to make state reconstructible.
- A declarative state-machine language.
- Claiming multi-record atomicity that storage doesn't provide.
- Unifying HITL execution or authorization just because the lifecycle is unified.

## Open questions

1. Do workflow steps have an identity that stays stable across retries, which lifecycle facts could derive IDs from?
2. Is two facts per synchronous call acceptable for stream size? Measure with ten parallel tool calls.
3. Should forwarded answers finish as `forwarded`, or at the parent's next stable point?
4. Is idle only a selector, or do channels need an explicit fact?
5. Must reconnects replay every delta, or only completed content?
6. Should attempts be public subordinate entities, or visible only to trusted channel code?
7. An upcaster for pre-break sessions, or no rewinds into them?
8. Do clients need commit grouping on the wire?
9. Do clients need `task.ended`, or is per-call settlement enough?
