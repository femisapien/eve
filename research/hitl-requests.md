---
issue: "TBD (no tracking issue yet; evidence issues listed under Motivation)"
status: draft
last_updated: "2026-10-02"
---

# HITL requests: held turns and one request table

## Decision

Every HITL request holds its turn open, and the answer continues the same turn. No request ends a
turn or starts one. `main` already holds the turn on approvals and sign-ins since #4135; this design
keeps that behavior and changes what sits underneath it.

A request has one owner, and the owner decides what continues when it is answered:

- **The turn** owns the requests it raises itself: a tool approval, a plain tool's sign-in, and the
  budget question. When the person answers, the turn continues. For an approval, eve appends the
  approval response and **the AI SDK runs the call in the next `generate()` of the held turn**,
  through its `toolApproval` path, as on `main`.
- **An `execute` call** owns the questions and sign-ins its workflow body raises (`ctx.ask`,
  `ask_question`, `requireAuth`), as on `main`.
- **A child session** owns the requests it relays up, as on `main`.

Every open request, whatever its kind and owner, is one entry in one table per session,
`openInputRequests`. Every kind is added, answered, and withdrawn through it, and cancel withdraws
them all.

A message from the person the turn serves that doesn't answer a request **steers** the turn and
withdraws the turn's open approvals and sign-ins, as on `main` since #4135. Messages from anyone
else wait for the turn to end.

The AI SDK runs an approved call only if the approval response is the last message in history. The
recurring approval-resume failures (#2594, #2826, #3594, #3899, #3943) all came from a message
written between the call and the approval response. In a held turn nothing else can be written
there, so one assertion where history is written replaces the guards each writer had to carry.

The authoring API does not change. Observable changes from `main`:

- a text reply answers a request only when that request is the only open one a message could answer
  (see Text answers); `main` answers every open request the text matches;
- the budget question holds the turn instead of ending it.

Line numbers refer to `origin/main` `61813722e` (2026-10-02). Paths are relative to
`packages/eve/src` unless they start with `research/`.

## Terms

| Term                | Meaning                                                                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| request             | One thing eve asks a person: an approval, a question, a budget question, or a sign-in. Identified by `requestId`                              |
| `openInputRequests` | The one table in session state that holds every open request, whatever its kind (see Proposed: one request table)                             |
| owner               | What a request belongs to and what continues when it is answered: the turn, an `execute` call, or a child session                             |
| held turn           | A turn that stays open while it has an open request or working task (`turn.waiting`, with `on: "input"` or `on: "tasks"`)                     |
| steering            | A message from the turn's principal arriving during the turn (`execution/session/input-queue.ts`)                                             |
| gated call          | A tool call whose approval policy returns `"user-approval"`, or that asked for a sign-in while it ran                                         |
| approval response   | The `tool-approval-response` part eve appends on Approve. The AI SDK runs the call only if it is in the last message (`collectToolApprovals`) |
| budget question     | The session-limit continuation request (`createSessionLimitContinuationRequest`), raised before a model call when the session is over budget  |
| response policy     | The tool's answer-time `approval.response`, deciding whether a responder may approve or cancel                                                |

## Motivation

### How it works today

Since #4135, an approval or a plain tool's sign-in holds the turn: the stream reports `turn.waiting`
with `on: "input"`, and the answer resumes the same turn (`holdTurnForRequest`,
`harness/tool-loop.ts:2852`). A steering message from the person withdraws the held sign-ins
(`withdrawHeldSignIns`, `harness/held-requests.ts`) and resolves the approvals `ignored`
(`harness/input-request-resolution.ts`).

What runs an approved call has not changed. The AI SDK calls eve's `toolApproval` callback during
`generate()` (`harness/tool-loop.ts:1593`), adds an approval part to the call, and runs the call in
a later `generate()` only if the approval response is the last message in history
(`collectToolApprovals` in `ai`). eve holds the waiting call outside history meanwhile, adds a
`[Pending approvals]` note, and writes the call back, followed by the approval response, when the
answer arrives. Plain-tool sign-in removes the interrupted call from history
(`projectCompletedSiblingCalls`, `harness/inline-tool-authorization.ts`).
A budget question still ends the turn (`harness/session-limit-enforcement.ts`).

Each request kind still has its own store and its own resume path (see Status quo).

### The record

From 2026-08-20 to 2026-09-30:

- **46 HITL issues** were filed, and 27 are still open. They cover tool approvals, `ask_question`
  and `ctx.ask`, budget questions, sign-ins, and how each is relayed, shown, and resumed.
- **About 40 HITL pull requests** were opened. 26 are bot-written fixes, and 20 of those were still
  unmerged on 2026-09-29.
- **87 commits** on `main` touched HITL files: 60 from 08-29 to 09-28, and 27 more by 09-30.
  `harness/tool-loop.ts` was touched by 55 commits since 08-29 and is now 3,355 lines.
- **The same failure keeps coming back.** Seven distinct issues, plus one duplicate, come from a
  message landing after an approval response or next to a waiting call. The approval is dropped, or
  the provider rejects the request and the session ends. Each was fixed with a guard at one site
  (#2656, #2919, #3595, #3903), and the next writer broke it again.

### The issues, by cause

The question for each issue is whether this design prevents it by construction, with no guard or
special case added for it, whether or not it has since been patched on `main`. Of the 46 issues,
29 are prevented and 17 are not.

| Cause                                                                                                                     | Prevented by design                                    | Not prevented                                                                      | Why                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A message lands after the approval response**, so the approval is dropped or the provider rejects a call with no result | #2594, #2699, #2826, #2874, #3594, #3771, #3899, #3943 |                                                                                    | Nothing can be written between the call and the approval response: no new turn starts, the model is not called while an approval is open, a steer first withdraws the approval, other principals wait, and cancel withdraws. One assertion where history is written checks it                    |
| **Resume loses turn context**: the turn id, the answering principal, turn-scoped connections, or a user message           | #3705, #3760 (and #3771 above)                         |                                                                                    | The answer continues the same turn, so nothing is rebuilt                                                                                                                                                                                                                                        |
| **Several approvals wait on each other**: one batch resolves per step                                                     | #3494, #3711, #4024                                    |                                                                                    | The model is not called while an approval is open, so only one step's approvals are open at a time. eve appends their answers together, and the SDK runs the approved calls in one `generate()`                                                                                                  |
| **A message is misread** as an answer, a dismissal, deferred input, or a new turn                                         | #2466, #2469, #3421 (and #2699, #3494, #3711 above)    | #3680, #4035                                                                       | One classifier handles every delivery in one order, and an open approval no longer changes how the model is called (#2466 and #2469 came from restricting tools while one was open). #3680 needs text to answer policy-guarded requests (open question 1). #4035 is how free-text questions work |
| **Pending state is split**, and cancel, steer, or settle clears only part of it                                           | #2421, #2442, #3414, #3458, #3887 (and #2874 above)    |                                                                                    | One table holds every open request, and cancel and steering withdraw from it. The harness stores where #2442 and #3414 went stale are gone. Each call's sign-in is its own entry, so finishing one doesn't re-run a step shared with the others (#2421)                                          |
| **Child and task relays drift** from the root path                                                                        | #2520, #3589, #3784, #3990 (and #3458 above)           | (#3680 above)                                                                      | Relayed requests use the same table, settle events, publication path, and "nobody can answer" rule as the turn's own (see Stream events)                                                                                                                                                         |
| **Events are missing or not reduced**, so clients and channels get stuck                                                  | #3757, #3911 (and #2520, #3705, #3784, #3990 above)    |                                                                                    | Every park emits `turn.waiting`, and approval state has one source, the `input.*` events                                                                                                                                                                                                         |
| **Policy and identity gaps**                                                                                              | #3198, #3891                                           | #3238, #3822, #3906                                                                | A gated call runs only after its request is answered, and the response policy runs in one place, when the session accepts an answer. #3238 is a choice of default, and #3822 and #3906 ask for identity the policy can't see yet                                                                 |
| **Outside this design**                                                                                                   |                                                        | #2319, #2471, #2476, #2779, #2806, #2845, #3103, #3497, #3546, #3615, #3712, #3895 | Channel rendering, configuration, durability, budget arithmetic for delegated sessions, scoped approval keys, and packaging                                                                                                                                                                      |

### Two root causes

The first three rows share one cause: an approved call is run by the AI SDK, which only runs it if
the approval response is the last message. The defenses are `hasTailApprovalResponse`
(`harness/current-messages.ts`, called from `harness/tool-loop.ts:888` and
`harness/workflow-dispatch.ts`) and a preamble reordering whose comment names the constraint ("so
an approval response stays in the final tool message, where the AI SDK reads it"). Each writer had
to know the rule because an approval ended the turn: the answer started a new turn, whose preamble
(timestamp, memory recall, turn context) or a steering message could be written first.

The rest share the other cause: an open request lives in one of six stores depending on its kind,
each with its own reader, writer, and clearing rule (see Status quo). A fix on one path doesn't
reach the others. #3891 is the clearest case: one park site omitted the response-policy flag, so the
policy was skipped when an approval parked next to a workflow call. #3954 fixed that site, and every
new park site still has to remember the flag.

Held turns (#4135) remove the first cause. The answer continues the held turn, so no preamble runs,
and nothing else is written while an approval is open (see History is append-only). The tail rule
stays; the writes that broke it can no longer happen, and one assertion checks that.
`openInputRequests` removes the second: every kind of request is stored, answered, and withdrawn the
same way.

## Requests and owners

### Status quo: six stores for open requests

On `main` today, an open request lives in one of six places, depending on its kind:

| Store                                                                  | Holds                                                                                                                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `eve.runtime.pendingInputBatches` (`harness/pending-input-batches.ts`) | Approvals and root budget questions, with the held-back call                                                               |
| `eve.runtime.deferredStepInput` (same file)                            | Messages that arrived while a batch was open                                                                               |
| `eve.runtime.hitl.approvalState` (`harness/approval-candidates.ts`)    | Approval answers waiting on the response policy                                                                            |
| `eve.runtime.pendingAuthorization` (`harness/authorization.ts`)        | Plain-tool sign-ins                                                                                                        |
| `eve.runtime.proxyInputRequests` (`harness/proxy-input-requests.ts`)   | `ctx.ask` questions and child requests                                                                                     |
| The workflow run itself (`execution/tools/workflow/step.ts`)           | Sign-ins inside a workflow step. The run waits for the callback on its own hook, and the session only publishes the events |

Each store has its own reader, its own writer, and its own rule for what clears it. The session's
idle check reads them by name before it allows a handoff (`execution/session/handoff-steps.ts`).

### Proposed: one request table

Every open request is one entry in `openInputRequests` (`eve.runtime.openInputRequests`), keyed by
`requestId`. An entry is one of two shapes, by owner:

| Entry                 | Owner                                       | Holds                                                                                                                                             |
| --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TurnInputRequest`    | The turn                                    | The `InputRequest` itself (approval, sign-in, or budget question), the call it gates if any, and the `input.requested` coordinates                |
| `RelayedInputRequest` | An `execute` call's run, or a child session | Where the answer goes (the run's control hook, or the child's session), and the `input.requested` coordinates, as `proxyInputRequests` does today |

How an entry comes and goes:

| Kind                         | Added when                                                              | Removed when                                                                               |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `tool-approval` (the turn's) | The approval policy returns `"user-approval"` for a call the model made | The answer is accepted, with a response policy once it allows it; or the turn withdraws it |
| `authorization` (the turn's) | A plain tool asks for a token it has no credential for                  | The sign-in completes or fails; or the turn withdraws it                                   |
| `session-limit`              | The turn is about to call the model over budget                         | The person picks Continue or Stop; or the turn is cancelled                                |
| `question`, relayed kinds    | The run or child asks, as on `main`                                     | The answer is routed to the owner, or the owner ends, as on `main`                         |

Every delivery is classified against the table in the same order:

1. **Answers.** Each `inputResponses` entry goes to its request's owner. It never steers.
2. **Text answers.** A text message from the turn's principal answers a request only when that
   request is the only open entry a message could answer, and the text matches one of its options
   (see Text answers). It is consumed and does not steer.
3. **Steering.** Any other message from the turn's principal steers the held turn. The turn's open
   approvals and sign-ins are withdrawn first (see Approvals). A relayed question is withdrawn, or
   answered when it accepts free text, as on `main` (#4035).
4. **Everyone else.** A message from another principal waits for the turn to end.

Cancel withdraws every entry the turn owns and cancels every run and child that owns one. The idle
check becomes one question: is the table empty?

### Owners

The session alone accepts or withdraws an answer. The owner is what continues once it does.

| Owner          | Requests                                                        | Continues on answer                                                                              |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Turn           | Approval or sign-in for a call the model made; budget question  | The AI SDK runs the approved call; the signed-in tool runs again; or the pending model call runs |
| `execute` call | `ask_question`, `ctx.ask`, `requireAuth` inside a workflow body | The call's body, as on `main`                                                                    |
| Child session  | Whatever the child raised                                       | The child, which holds its own turn, as on `main`                                                |

These rules apply to every owner:

| When                                                                | Then                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| The session is cancelled, or the turn is cancelled                  | Every open request the turn owns is withdrawn (`input.resolved` `cancelled`)                   |
| An answer or callback arrives for a withdrawn or answered request   | It is stale and changes nothing                                                                |
| Nobody can answer (a schedule, or a session without `requestInput`) | The request resolves `unavailable` at once                                                     |
| A child session raises a request                                    | The child holds its own turn; the request travels up and the answer routes down by `requestId` |

## Approvals

### The usual path

1. The model calls `send_email`. The approval policy returns `"user-approval"`.
2. The AI SDK adds an approval part to the call. eve adds a turn entry naming the call and emits
   `input.requested`. The call stays at the tail of history. The turn holds (`turn.waiting`,
   `on: "input"`), and the model is not called.
3. The person approves. If the tool has a response policy, it checks who answered.
4. eve appends the approval response, the only write while the turn holds.
5. In the next `generate()` of the same turn, the AI SDK runs `send_email` with the model's
   original input, appends its result, and calls the model.

### Everything else

| What happens                                                                     | Result                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The approval policy returns `"approved"` or `"not-applicable"`                   | The call runs right away, as on `main`                                                                                                                                                                                                                         |
| The approval policy returns `"denied"`                                           | The call does not run; its result says it was denied                                                                                                                                                                                                           |
| The person denies                                                                | The call does not run; eve appends a result saying the person declined                                                                                                                                                                                         |
| The response policy rejects whoever answered (Approve or Cancel, as since #3954) | The request stays open for someone else (`input.candidate` `rejected`)                                                                                                                                                                                         |
| The turn's principal sends a message that is not a text answer                   | It steers. The approval is withdrawn (`input.resolved` `ignored`), the call's result says it did not run, and the model reads the message                                                                                                                      |
| One step makes several gated calls                                               | One entry per call. Once all are answered, eve appends their answers together and the SDK runs the approved ones in one `generate()`. A steer withdraws the ones still open; calls already approved still run, and the message is appended after their results |
| The call also needs a sign-in                                                    | The approval comes first; the sign-in only comes up once the approved call runs                                                                                                                                                                                |
| The turn is cancelled                                                            | The approval is withdrawn (`input.resolved` `cancelled`); a later answer approves nothing                                                                                                                                                                      |

### Walkthrough

Alice asks the agent to email a report.

| #   | What happens                                                 | The model reads                  | The model does                    | Events                                                 |
| --- | ------------------------------------------------------------ | -------------------------------- | --------------------------------- | ------------------------------------------------------ |
| 1   | Alice: "email the report to Bob"                             | Her message                      | Calls `send_email`                | `turn.started turn_1`, `actions.requested`             |
| 2   | The policy asks for approval. eve adds entry `a1`            | Nothing; the model is not called |                                   | `input.requested a1`, `turn.waiting on: "input"`       |
| 3   | Alice clicks Approve. The session accepts the answer         | Nothing yet                      |                                   | `input.resolved a1 approved`                           |
| 4   | eve appends the approval response; the SDK runs `send_email` | The result: sent                 | Replies "Sent the report to Bob." | `action.result`, `message.completed`, `turn.completed` |

Every event carries `turn_1`.

### How an approval runs

| Stage    | Today                                                                                                                                                             | Under this design                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decide   | During `generate()`, the AI SDK calls eve's `toolApproval` callback (`buildToolApproval`, `harness/tools.ts`), which runs the tool's policy                       | Unchanged                                                                                                                                                            |
| Ask      | The SDK adds an approval part to the call. eve moves the call out of history into a pending batch, adds a `[Pending approvals]` note, and emits `input.requested` | eve adds a turn entry naming the call and emits the same `input.requested`. The call stays at the tail of history; the model is not called                           |
| Answer   | The approval coordinator runs the response policy                                                                                                                 | The same coordinator runs the response policy against the turn entry. A rejection leaves the entry open                                                              |
| Remember | An approved tool is recorded in `eve.runtime.hitl.approvedTools`, which `once()` reads                                                                            | Same record, written when the session accepts an Approve                                                                                                             |
| Run      | The SDK runs `execute` in the next `generate()`, only if the approval response is the last message                                                                | The SDK runs `execute` in the next `generate()` of the held turn. The approval response is guaranteed last, because nothing else can be written while the turn holds |

The built-in policies keep their meaning: `always()` always asks, `never()` never asks, `once()` asks
until the tool has been approved once in the session, and `auto()` asks its evaluation model at the
Decide stage.

The SDK runs the call inside the held turn with the turn's tools, so every kind of tool works the
same way: authored tools, connection tools, MCP tools, dynamic tools, built-in tools such as `bash`,
and agent tools. The SDK path also keeps its policy re-check (used for connection pinning),
`toModelOutput`, streamed partial output, and sign-in signals.

### If Alice writes something else

At walkthrough row 2 the table holds one entry, `a1`, with options id `approve` / label "Approve"
and id `cancel` / label "Cancel".

| Message                                                     | eve reads it as                                  | The turn                                                                | The model                                                                |
| ----------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Alice: "approve" (or "Approve", "1")                        | A text answer: Approve for `a1`                  | Stays open; eve appends the approval response and the SDK runs the call | Called with the result, as in row 4                                      |
| Alice: "cancel" (or "2")                                    | A text answer: Cancel for `a1`                   | Stays open; the call's result says declined                             | Called with that result                                                  |
| Alice: "actually, send it to Carol"                         | Steering                                         | `a1` is withdrawn (`ignored`); the call's result says it did not run    | Called with her message; calls `send_email` for Carol, which raises `a2` |
| Alice: "approve", while a second approval `a2` is also open | Steering. With two entries, text answers neither | Both are withdrawn                                                      | Called with her message; asks which one she meant                        |
| Bob: "approve"                                              | Waits. Bob isn't the turn's principal            | Unchanged                                                               | Not called for it. Bob's message runs after `turn_1` ends                |

Bob can still answer `a1` with a structured answer, such as a button. If the tool has a response
policy, it decides whether Bob may.

## Sign-ins

Two things can stop a call before it finishes, and eve learns about them at different times: an
approval before the call runs, and a sign-in only while it runs (the tool asks for a token with
`getToken` or `requireAuth` and there is no credential yet).

| Stage  | Today, plain tool                                                                                                     | Under this design                                                                                           |
| ------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Detect | The tool's result carries an authorization signal (`readAuthorizationSignal`, `harness/inline-tool-authorization.ts`) | The same                                                                                                    |
| Ask    | eve emits `authorization.required`, removes the call from history, and holds the turn (#4135)                         | eve adds a turn entry and emits `authorization.required`. History is handled as on `main` (open question 2) |
| Answer | The provider's callback resumes the held turn                                                                         | The same; the session removes the entry                                                                     |
| Run    | The tool runs again from the start                                                                                    | The same                                                                                                    |

Workflow bodies keep their own sign-ins: the run waits on its own hook, and the session only
publishes the events (`execution/tools/workflow/step.ts`). Nothing about them changes.

After a sign-in the tool runs again from the start, as today, so code before its `getToken` call
runs twice. A call that needs an approval and a sign-in gets them in that order: nobody signs in for
a call that is then denied.

## History is append-only

One example runs through both halves. Alice's agent has a `turn.started` instruction with role
`user` that writes the current time, the setup from #3899. Alice asks it to email the report to Bob
at 10:00 and clicks Approve at 10:02.

### Status quo: the waiting call is held out, then spliced back in

The AI SDK runs an approved call only if the approval response is the last message
(`collectToolApprovals`). So eve keeps the call out of history while it waits and writes it back,
with the approval response at the end, when the answer comes:

```text
user       "email the report to Bob"
user       [Pending approvals] send_email
assistant  tool-call send_email (c1)                        written back after the answer
tool       tool-approval-response (approved)                must be last
```

Until #3903, the memory-recall path appended the 10:02 timestamp after the approval response. That
is #3899: the SDK found no approval at the tail, never ran `send_email`, and the provider rejected
the request ("No tool output found for function call c1"). Every writer has to know the same rule:

- Current-turn context is sent as a system message instead of being written to history
  (`harness/current-messages.ts`).
- A message that arrives with the approval answer is held until the next step
  (`harness/input-requests.ts`).
- A denial also writes an `execution-denied` result, because the SDK strips old approval responses
  when it builds the provider prompt (`harness/hitl/approval-input-requests.ts`).
- Plain-tool sign-in edits history the other way: it removes the interrupted call
  (`projectCompletedSiblingCalls`).

### Proposed: every write is complete when it's made

```text
user       "email the report to Bob"                        10:00
assistant  tool-call send_email (c1), approval request      10:00; the model is not called while c1 waits
tool       tool-approval-response (approved)                10:02, Approve; the only write while the turn holds
tool       tool-result c1: sent                             the SDK, in the next generate()
assistant  "Sent the report to Bob."
```

And if Alice steers at 10:01 instead:

```text
user       "email the report to Bob"                        10:00
assistant  tool-call send_email (c1)
tool       tool-result c1: not run; Alice sent a new message 10:01, written when the approval is withdrawn
user       "actually, send it to Carol"                     10:01, steering
```

The answer continues `turn_1`, so `turn.started` doesn't fire again and no 10:02 timestamp is
written. While the turn holds on approvals, nothing but the answer can be written:

- no new turn starts, so no preamble runs;
- the model is not called while an approval is open;
- a steer from the turn's principal first withdraws the approval, writing a not-run result
  (`ignored`), and only then appends the message;
- a message from anyone else waits for the turn to end;
- cancel withdraws the approval.

So the tail rule needs no per-writer guard. One assertion where history is written checks that,
while a turn holds on approvals, the only thing appended is the answer. It replaces the per-writer
`hasTailApprovalResponse` checks, the preamble reordering, and the deferred input. The
held-out call and the `[Pending approvals]` note go too: the call is in history the whole time.

Plain-tool sign-ins still remove the interrupted call, as on `main` (open question 2).

## Budget questions

A budget question has no tool call. The model cannot run until it is answered, so the turn owns it
and waits.

1. Before every model call, eve checks the session's token budget.
2. Over budget, eve adds a turn entry, emits `input.requested`, and the turn holds (`turn.waiting`).
3. Continue extends the budget and makes the model call the turn was about to make, in the same
   turn. Stop cancels the turn, and the question resolves once, `answered`.

| While the question is open           | Result                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| The turn's principal sends a message | It waits in the turn and runs once the budget is granted, the rule #4135 describes |
| The turn is cancelled                | The question is withdrawn (`input.resolved` `cancelled`)                           |

Unchanged from today: with nobody to answer, the turn fails with `SESSION_TOKEN_LIMIT_REACHED`, and a
child that inherited a zero budget fails so its parent asks instead.

## Text answers

A text message from the turn's principal answers a request when two things hold: the request is the
only open entry a message could answer (relayed questions and approvals, and the turn's own
requests, all count), and the text matches one of its options by id, label, or number, using
today's matcher (`channel/resolve-text.ts`). A question that accepts free text takes any text
(#4035). Requests with a response policy are not answered by text, as today.

With two or more candidates, text answers none of them and steers instead, so the model can ask
which one is meant. On `main`, one text reply answers every open request it matches
(`resolveTextToResponses`), which is safe only while every open request came from the same step.

GitHub and Linear render options as numbered text, and child relays match text too
(`subagents/hitl-proxy.ts`). They keep working; they lose only the multi-request text answer.

## The model in a held turn

eve calls the model only when there is something new to read and no call lacks a result.

| eve calls the model when            | New in the prompt                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| The turn starts                     | The person's message                                                                            |
| A step's approvals are all answered | The approval responses; the SDK runs the approved calls first, so the model reads their results |
| The turn's principal steers         | The withdrawn calls' results, then the message                                                  |
| A task settles                      | The task result, and a refreshed `[Tasks]` note                                                 |
| A budget question gets Continue     | Nothing; the pending model call runs                                                            |

**Only a person grants.** The model never answers a request. It made the call it would be
approving, and tool output claiming "the user approved" must never become a grant.

## Stream events

| Event                                       | `main` today                                                                 | Proposed                     |
| ------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| After `input.requested` (approval, sign-in) | `turn.waiting` `on: "input"` (#4135)                                         | Unchanged                    |
| After `input.requested` (budget question)   | `turn.completed`, `session.waiting`                                          | `turn.waiting` `on: "input"` |
| An approved call's result                   | `action.result` from the SDK's run in the next `generate()` of the held turn | Unchanged                    |
| A steer withdraws an approval               | `input.resolved` `ignored`                                                   | Unchanged                    |

Three rules keep events uniform across the turn's own and relayed requests:

- **One publisher.** A request's events are published once, by the session whose table holds it,
  on the same path as every other event, so hooks and channels see them. For a relayed child
  request that is the root, whose channel showed the prompt (#2520, #3784, #3990).
- **Every park says so.** Each time a held turn parks, including after a rejected answer, it emits
  `turn.waiting` (#3757).
- **One source of approval state.** Clients read an approval's state only from `input.requested`
  and `input.resolved`, not from the approval parts in history (#3911).

## Invariants

1. The model is never called while a tool call in history has no result. While a turn holds on
   approvals, the only thing appended to history is the answer.
2. Every request has one owner. No request ends a turn, resumes an ended turn, or starts a turn.
3. Every event of one request carries the requesting turn's `turnId`.
4. A gated call runs only in its own held turn, after its requests are answered.
5. The approval policy runs once per call. The response policy runs once per answer, when the
   session accepts it.
6. Only a person's answer grants. Model output never answers a request.
7. Every open request is one entry in `openInputRequests`, and every delivery is classified against
   that table in one order.

## Where each piece lives

| Piece             | Where                                                                       | What changes                                                                                                               |
| ----------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Gate              | `buildToolApproval` (`harness/tools.ts`), called by the AI SDK              | The park adds a turn entry naming the call, and the call stays in history                                                  |
| History assertion | Where history is written                                                    | While a turn holds on approvals, only the answer may be appended; replaces the per-writer `hasTailApprovalResponse` checks |
| Budget check      | `enforceSessionUsageLimit`, before every model call                         | Adds a turn entry and holds the turn instead of ending it                                                                  |
| Request table     | `harness/open-input-requests.ts`, replacing the stores listed in Status quo | Every request kind is added, answered, and withdrawn here                                                                  |
| Response policy   | `harness/approval-delivery-coordinator.ts`                                  | Reads turn entries instead of pending batches                                                                              |
| Steer rule        | One function where deliveries are classified                                | Withdraws the turn's approvals and sign-ins (see Keeping the old steer rule in reserve)                                    |

## What this removes

- The call held outside history, and the `[Pending approvals]` note (`harness/hitl/approval-prompt.ts`).
- The pending input batches (`harness/pending-input-batches.ts`), replaced by turn entries, and the
  logic for more than one open batch.
- The deferred turn input and the preamble reordering for approvals (`harness/input-requests.ts`,
  `harness/current-messages.ts`).
- The harness's answer classifier for approvals and budget questions (`resolveTextMessageInput`,
  `routePendingInput` in `harness/input-requests.ts`).
- The separate stores for open requests (`eve.runtime.pendingInputBatches`, `deferredStepInput`,
  `hitl.approvalState`, `pendingAuthorization`, and `proxyInputRequests`), replaced by
  `openInputRequests`. `eve.runtime.hitl.approvedTools` stays: it records grants for `once()`, not
  open requests.

Kept: the AI SDK's `toolApproval` path and the approval-response part, used only at the tail of a
held turn; `hasTailApprovalResponse`, which becomes the single history assertion or is replaced by
it; workflow tools dispatched from the approval message, as today; and the approval delivery
coordinator for response policies, moved onto turn entries.

## Accepted costs

1. **A steer ends the open approval.** The person can always talk, but talking withdraws what the
   turn was waiting on; the model sees the call did not run and can call it again.
2. **Other principals wait.** Another person's message queues behind a held turn, as on `main`
   (`research/eve-tasks.md` §11, risk 4).
3. **Long turns.** Turn duration and trace spans include time waiting for a person.

## Keeping the old steer rule in reserve

An earlier draft let an approval survive a steer, so a person could keep talking while it stayed
answerable. The steer side of that rule lives in one function, but running the call later does not
fit the SDK path. Switching to it would change three things:

1. When a steer arrives, the waiting call gets a placeholder result ("waiting for approval; it has
   not run"), since the model is about to be called and every call needs a result.
2. When the person approves later, the call runs and its real result arrives as a later message,
   the way task results do (`appendTaskContext`, `execution/tasks/model-step.ts`). The approval
   response would no longer be last, so the SDK cannot run it: eve would have to run the call
   itself, or as a task. That is why this mode is not built now.
3. The model gets a `withdraw_request` tool to drop an approval the person no longer wants, keyed by
   `requestId`. It is not `task_cancel`: an approval is not a task.

## Migration

Pre-1.0: breaking, no dual path. Sessions parked under the old model are not rewritten. The handoff
check refuses to move a session that still holds an old approval, sign-in, budget, or relayed-request
key, so it finishes on the deployment that can still answer it.

The work starts from `main`, which already holds the turn, and keeps `main`'s e2e set passing at
every step:

1. One table: rename `proxyInputRequests` to `openInputRequests` and add turn entries.
2. The budget question becomes a turn entry and holds the turn.
3. Text answers count every open request.
4. Approvals: the call stays in history, approvals become turn entries, and eve appends the approval
   response on answer; the held-out call, the note, the deferred input, and the pending batches go.
5. Plain-tool sign-ins become turn entries; `pendingAuthorization` goes.
6. Clients and channels read approval state only from `input.*` events.

Response policies build on #3929 (open), which runs a `ctx.ask` response policy as a step.

## Alternatives considered

- **Gated calls as tasks** (the previous draft of this document). The call got a receipt at once,
  and a gate task, a separate workflow run, asked the person and ran the call. It kept the
  conversation going while an approval waited, but the run has to execute the tool outside the
  session. A spike showed what that costs: authored tools and declared connections can be loaded by
  name, but dynamic tools exist only in the session (their callbacks are bound per process and
  rebuilt by re-running the session's resolvers), sandbox tools need the session's sandbox, and
  agent tools go through the session's dispatch. Each needed its own reconstruction in the run, a
  context snapshot, a resolver rebind, or a sandbox handoff, and a sandbox the run started would be
  unknown to the session. Running the call in the turn needs none of it.
- **eve runs approved calls itself** (an earlier version of this draft). It drops the tail rule, but
  eve would have to rebuild what the SDK path already does: the policy re-check used for connection
  pinning, `toModelOutput`, streamed partial output, and sign-in signals.
- **Hold the call back and answer steering without it.** The model does not know its own call is
  pending, and writing the call and its result later puts them after messages they came before.
- **Hold the turn and queue every message.** Keeps the request open but locks the conversation until
  someone answers (#3494).
- **Make the budget question a task.** A task starts from a tool call; a budget question has none,
  must not wake the model on steering, and cancels the whole turn when declined.
- **Let the model answer requests from messages.** Handles phrasing that exact matching misses, but
  the model would approve its own call, and tool output could produce the grant.
- **Channels translate text into `inputResponses`; the core stops parsing.** Duplicates today's
  matcher in every text channel and breaks custom channels without warning.
- **Keep SDK approvals and centralize the tail guard** (#2344, closed). This design also keeps SDK
  approvals, but #2344 kept the approval ending the turn, so the answer started a new turn and the
  guard had to cover every writer that could run first. Held turns remove those writers, so one
  assertion is enough.
- **Unify pending state only** (#2652, #2822, #2863, #3575). Each request kind still resumes on its
  own path, and the writers that break the tail rule remain.

## Open questions

1. **Should text answer an approval that has a response policy?**
   - Known: today only a structured answer can settle such an approval, never text. Linear always
     sends replies as text, so those approvals can't be answered from Linear (#3680).
   - Option: treat a text answer like a structured one, with the message's sender as the responder,
     and run the policy on it.
   - Not known: whether every text channel identifies the sender well enough to act as a responder.
2. **Where does a plain tool's sign-in callback land once `pendingAuthorization` goes?**
   - Known: on `main` the callback resumes the held turn; a workflow body's callback goes to its own
     run's hook.
   - Not known: whether the turn entry can carry the per-attempt callback token the provider needs,
     or whether the callback should stay on its current route and only the open request move.
   - Not known: whether the interrupted call can stay in history. The SDK re-runs a call only through
     an approval response, so keeping the call would need eve to re-run it; until then sign-ins
     remove it, as on `main`.

Follow-ups, not needed for the first version: one `input.requested` per step for several gated calls,
and default request deadlines in shared threads (reusing `expireApprovalCandidates`).

## Validation

The implementation keeps `main`'s e2e set passing, and adds tests for each step. It passes if:

1. The reproductions for #3899, #2826, and #3594 pass, and the history assertion never fires in
   `main`'s e2e set.
2. Every event of one approval carries one `turnId`, and the call runs under the requesting turn's
   principal and connections (the #3705 and #3760 shapes).
3. #3891's step, an approval next to a blocking workflow tool, runs the response policy for Approve
   and Cancel with no park-site flag.
4. An approval-gated dynamic tool, a sandbox tool, and an agent tool each run after Approve, in the
   same turn.
5. A steering message while an approval is open withdraws it, and the model reads the message with
   the call's not-run result before it.
6. A budget question holds the turn: Continue runs the pending model call under the same `turnId`,
   Stop cancels the turn and resolves the question once, and cancel withdraws it.
7. Typing `approve` answers a single open approval and does not steer; with two open, it answers
   neither and steers.
8. The session's handoff idle check reads only `openInputRequests` and the run registry.
