---
issue: "TBD (no tracking issue yet; evidence issues listed under Motivation)"
status: draft
last_updated: "2026-09-30"
---

# HITL requests: held turns, and gated calls as tasks

## Decision

Every HITL request holds its turn open. The answer continues the same turn, and no request ends a
turn or starts one.

A request has one owner, and the owner decides what continues when the request is answered:

- **A tool call that needs a person** (an approval or a sign-in) runs as a task. The call gets a
  receipt as its result at once. The task waits for the person, runs the call, and delivers the
  outcome to the model as a task result in the same turn. The conversation continues while it waits.
- **A budget question** (the session is over its token budget) is owned by the turn. The turn pauses
  until the person answers, then makes the model call it was about to make.
- **A question** (`ask_question`) is unchanged: it belongs to the `execute` call that asked.

Tasks are used only where a tool call is waiting, because only there does the call need a result
before the conversation can go on. This removes the one state in which eve's history holds a tool
call without its result. That state causes the recurring approval-resume failures (#2594, #2826,
#3594, #3899, #3943) and the sign-in resume without a user message (#3771).

Gated calls reuse the task model on `main` (#3840, #3850) as is. The one new wait is a turn waiting
on its own budget question; it parks on the same session inbox as `task_wait`.

The authoring API does not change. The observable changes are:

- approvals, sign-ins, and budget questions no longer end the turn; every event of one request
  carries one `turnId`;
- the model sees a receipt and later a task result, instead of a call held back until it runs;
- a person can keep talking while an approval or sign-in is open, and it stays open;
- the model withdraws a request with `task_cancel`, not a message heuristic;
- a text reply still answers a request when it matches an option of exactly one open request. Any
  other message steers the open turn and leaves requests open. Text-only channels see this most:
  GitHub and Linear render options as text, and Twilio, linq, and photon have no approval UI.

Line numbers refer to `origin/main` `66f295eb6` (2026-09-28) and `ai@7.0.105`; every symbol and file
named here still exists on `e9dd41827` (2026-09-30). Paths are relative to `packages/eve/src` unless
they start with `research/`. Since the baseline, #3928 and #3954 pass the requester to response
policies and run them for Cancel too, and #3983 gates workflow dispatch on approval. This design
keeps both behaviors.

## Terms

| Term            | Meaning                                                                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| request         | One question eve puts to a person: an approval, a budget question, or a sign-in challenge. Identified by `requestId`                         |
| owner           | What a request belongs to and what continues when it is answered: a gate task, an `execute` call, or the turn                                |
| held turn       | A turn that stays open while it has a working task or an open request it owns (`turn.waiting`)                                               |
| steering        | A message from the turn's principal arriving during the turn (`execution/session/input-queue.ts:223-234`)                                    |
| gated call      | A tool call whose approval policy returns `"user-approval"`, or whose tool needs a sign-in eve cannot satisfy yet                            |
| gate task       | The task eve starts for a gated call. It owns the call's requests and runs the call once they are answered                                   |
| receipt         | The gated call's tool result, written at once: "Task t1 is waiting for approval to run send_email. It has not run."                          |
| task result     | The `task.result` message that later carries the call's real outcome to the model                                                            |
| budget question | The session-limit continuation request (`createSessionLimitContinuationRequest`), raised before a model call when the session is over budget |
| response policy | The tool's answer-time `approval.response`, deciding whether a responder may approve or cancel                                               |

## Motivation

Today an approval ends the turn while the tool call has no result. eve holds the call back. The answer
starts a new turn, which rebuilds context and writes the call back into history, followed by the AI
SDK's approval response. The SDK runs the call only if that response is the last message
(`collectToolApprovals`, `ai@7.0.105` `dist/index.js:2936`). Plain-tool sign-in also ends the turn,
removes the interrupted call from history (`harness/inline-tool-authorization.ts:62-89`), and resumes
from the callback in a new turn with no user message (`execution/session/program.ts:332-343`). A
budget question ends the turn too (`harness/session-limit-enforcement.ts:146`).

This produces five failure classes:

1. **Tail order.** Any framework message written after the approval response drops the approval:
   skills (#2826), `clientContext` (#3594), memory recall with turn instructions (#3899, #3943),
   sign-in resume (#3771), a second park (#2594). The defenses are `hasTailApprovalResponse`
   (`harness/current-messages.ts:57`, `harness/input-requests.ts:124`) and a preamble reordering
   whose comment names the constraint ("so an approval response stays in the final tool message,
   where the AI SDK reads it"). #3983 adds another writer that must respect it, and its PR leaves a
   known case open: a provider failure after an approval resume drops the approval exchange.
2. **Resume context.** The approving turn rebuilds the turn id, principal, and turn-scoped
   connections (#3705, #3760, #3751). One approval spans the turn ids `""`, `turn_1`, `turn_2`.
3. **Single tail.** Only one tool message can be last, so one approval batch resolves per step
   (#3711, #3564).
4. **Park-path divergence.** Each park site builds its own pending state. One omitted the
   response-policy flag, so the policy was skipped when an approval parked next to a workflow call
   (#3891). #3954 fixed that site; every new park site still has to remember the flag.
5. **Split interpreters.** Approvals live in harness session state; questions, child requests, and
   workflow sign-ins live in the execution layer's route map.

Classes 1 to 3 exist because a call waits without a result. Classes 4 and 5 exist because each
request kind has its own park and resume path.

## Requests and owners

All requests share one route. The session alone accepts or withdraws an answer, as it already does
for `ctx.ask` (`research/eve-tasks.md` §7, "One inbox per run"). An answer goes to the request's
owner and never steers the turn.

| Owner          | Requests                                                        | Continues on answer                                       | Carries `taskId`                                |
| -------------- | --------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Gate task      | Approval, sign-in for a tool call                               | The task runs the call; the task result reaches the model | Yes                                             |
| `execute` call | `ask_question`, `ctx.ask`, `requireAuth` inside a workflow body | The call's body, as on `main`                             | Only when the body runs as a task, as on `main` |
| Turn           | Budget question                                                 | The model call the turn was about to make                 | No                                              |

**The held turn.** A turn stays open while it has a working task or an open request it owns. eve
calls the model only when there is something new to read and no budget question is open. Between
calls the turn is parked (`turn.waiting`) and costs nothing.

These rules apply to every owner:

| When                                                                | Then                                                                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The turn's principal sends a message that is not a text answer      | It steers the turn. Approvals and sign-ins stay open; an `execute` call's question is withdrawn, as on `main`; during a budget question the message is saved for after Continue |
| Another principal sends a message                                   | It waits for the turn to end                                                                                                                                                    |
| The session is cancelled, the turn fails, or the session ends       | Every open request is withdrawn (`input.resolved` `cancelled`)                                                                                                                  |
| An answer or callback arrives for a withdrawn or answered request   | It is stale and changes nothing                                                                                                                                                 |
| Nobody can answer (a schedule, or a session without `requestInput`) | The request resolves `unavailable` at once                                                                                                                                      |
| A child session raises a request                                    | The child holds its own turn; the request travels up the owner chain and the answer routes down by `requestId`, as child questions do today                                     |

## Gated calls

A task on `main` is "a call that returns a receipt at once and keeps working"
(`research/eve-tasks.md`, Vocabulary). A gated call is exactly that. The receipt gives the call its
result right away, so the conversation can go on without editing history.

### The usual path

1. The model calls `send_email`. The approval policy returns `"user-approval"`.
2. eve starts gate task `t1` and writes the receipt as the call's result. The person sees the
   approval prompt, and the turn keeps going.
3. The person approves. If the tool has a response policy, it checks who answered.
4. `t1` runs `send_email`. Its task result reaches the model in the same turn.

### Everything else

| What happens                                                                     | Result                                                                                                      |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The approval policy returns `"approved"` or `"not-applicable"`                   | The call runs right away. No task, no receipt                                                               |
| The approval policy returns `"denied"`                                           | The call does not run; its result says it was denied                                                        |
| The person denies                                                                | `t1` settles `completed`; the task result says the call was denied and did not run                          |
| The response policy rejects whoever answered (Approve or Cancel, as since #3954) | The request stays open for someone else                                                                     |
| The tool needs a sign-in                                                         | Same path; `t1` waits for the sign-in instead of an approval                                                |
| The sign-in fails or times out                                                   | The task result says the call did not run, and why                                                          |
| The call needs an approval and a sign-in                                         | eve asks for the approval first and the sign-in after it, so nobody signs in for a call that is then denied |
| One step makes several gated calls                                               | One gate task per call. Each call runs as soon as its own requests are answered                             |
| The model calls `task_cancel(t1)`                                                | `t1`'s requests are withdrawn; the call never runs                                                          |
| A late sign-in arrives after withdrawal                                          | The credential may be stored; the withdrawn call never runs                                                 |

Everything else a gate task does is the task model on `main`: it counts toward the task cap, the
turn cannot end while it works, and `final_output` returns the error naming working tasks.

### Walkthrough

Alice asks the agent to email a report, then keeps talking while the approval is open.

| #   | What happens                          | The model reads                                | The model does                                   | Events                                                  |
| --- | ------------------------------------- | ---------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| 1   | Alice: "email the report to Bob"      | Her message                                    | Calls `send_email`                               | `turn.started turn_1`                                   |
| 2   | eve gates the call and starts `t1`    | The receipt: waiting for approval, has not run | Replies "I've asked for approval."               | `task.started t1`, `input.requested t1`, `turn.waiting` |
| 3   | Alice: "also, what's on my calendar?" | Her message                                    | Calls `calendar.list`, then replies with her day | `turn.waiting`                                          |
| 4   | Alice clicks Approve                  | Nothing; the model is not called               |                                                  | `input.resolved t1 approved`                            |
| 5   | `t1` sends the email                  | The task result: sent                          | Replies "Sent the report to Bob."                | `task.settled t1 completed`, `turn.completed turn_1`    |

Every event carries `turn_1`. The turn ends at step 5 because nothing is working anymore.

What the model should do if Alice writes something else at step 3:

| Alice writes                 | The model                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| "approve"                    | Is not called. The text answers the one open request, and the flow goes on at step 5 |
| "actually, send it to Carol" | Cancels `t1` with `task_cancel` and calls `send_email` again, which starts `t2`      |
| "did it send?"               | Answers from the receipt in its history: not yet, it's waiting for approval          |

### History is append-only

History is never edited after a write. After the walkthrough it holds, in the order written: Alice's
message, the `send_email` call, the receipt, the reply, Alice's second message, the calendar call and
its result, the reply, the task result, and the final reply.

This is how every task result reaches the model on `main`: `appendTaskContext` appends one
`task.result` message and the `[Tasks]` note at a step boundary and never touches the receipt
(`execution/tasks/model-step.ts:145-168`).

Nothing is stitched. Holding the call back, writing it back with an approval response, removing an
interrupted call, and ordering preamble messages around the tail all go away. Replacing the receipt
with the real result later would be a history rewrite: it brings back ordering rules, invalidates the
provider's prompt cache from that point, and hides from the model what it was told while it waited.

## Budget questions

A budget question has no tool call, so it needs no receipt and no task. The model cannot run until
it is answered, so the turn owns it and waits.

### The usual path

1. Before every model call, eve checks the session's token budget.
2. The budget is spent. eve asks the person whether to continue (`input.requested`), and the turn
   pauses (`turn.waiting`). It does not end.
3. The person picks Continue. eve extends the budget and makes the model call it was about to make,
   in the same turn.

### Everything else

| While the question is open           | Result                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| The person picks Stop                | The turn is cancelled, as today (`SessionLimitDeclinedError`)                               |
| The turn's principal sends a message | It is saved; the model reads it after Continue. Channels show the pause from `turn.waiting` |
| A gate task settles                  | Its task result is saved; the model reads it after Continue                                 |

Unchanged from today: with nobody to answer, the turn fails with `SESSION_TOKEN_LIMIT_REACHED`, and
a child that inherited a zero budget fails so its parent asks instead.

## Text answers

A text message from the turn's principal answers a request when it matches an option of exactly one
open request, by id, label, or number, using today's matcher (`channel/resolve-text.ts`). The message
is consumed and does not steer. Requests with a response policy are not answered by text, as today.

With two or more open requests, text answers none of them and steers instead, so the model can ask
which one is meant. On `main`, one text reply answers every open request it matches
(`resolveTextToResponses`), which is safe only while every open request came from the same step.
Under this design approvals can stay open across a conversation, and "approve" must not grant an
approval raised ten messages earlier.

GitHub and Linear render options as numbered text, and child relays match text too
(`subagents/hitl-proxy.ts:323`). They keep working; they lose only the multi-request text answer.

## The model in a held turn

The model never waits. eve calls it when there is something new to read.

| eve calls the model when        | New in the prompt                                      |
| ------------------------------- | ------------------------------------------------------ |
| The turn starts                 | The person's message                                   |
| A step's tool calls finish      | Their results, including a receipt for each gated call |
| The turn's principal steers     | The message                                            |
| A task settles                  | The task result, and a refreshed `[Tasks]` note        |
| A budget question gets Continue | Nothing; the pending model call runs                   |

An answer does not call the model: it goes to the owner, and the model is called when the task
result arrives.

| The model                           | eve                                                               |
| ----------------------------------- | ----------------------------------------------------------------- |
| Calls tools                         | Runs each one or gates it; a gated call gets its receipt at once  |
| Replies with text while tasks work  | Posts it (`finishReason: "stop"`), keeps the turn open, and parks |
| Replies with text and no task works | Ends the turn                                                     |
| Calls `task_wait`                   | Parks without posting, until a task settles or a message arrives  |
| Calls `task_cancel({ taskId })`     | Withdraws that task's requests; the call never runs               |

The receipt reads:
`Task t1 is waiting for approval to run send_email. It has not run. Its result will arrive in a <task_result> message.`
The sign-in variant names the connection. Task guidance adds two lines: cancel a waiting task when
the person changes what they want, and don't report a gated action as done before its result
arrives.

**Only a person grants.** The model can withdraw a request but never answer one. It made the call it
would be approving, and tool output claiming "the user approved" must never become a grant.

## Stream events

| Event                                                        | Today                                                              | Proposed                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------- |
| After `input.requested` (approval, sign-in, budget)          | `turn.completed`, `session.waiting`                                | `turn.waiting`                                            |
| `input.requested`, `authorization.required` for a gated call | No `taskId`                                                        | `taskId` of the gate task                                 |
| `input.resolved`, `approval.settled`                         | Around a new turn; `approval.settled` with turn id `""` (inferred) | The requesting turn's `turnId`                            |
| The gated call's outcome                                     | `action.result` in a new turn                                      | `task.started` at the call, `task.settled` at the outcome |
| The answering delivery                                       | `turn.started` with a new `turnId`                                 | `step.started` with the same `turnId`                     |

Response readers (`send().result()`, MCP) already stop at `turn.waiting` while requests are pending
(`client/session-utils.ts` `isTurnSegmentBoundary`), and return `status: "waiting"`.

## Invariants

1. History is append-only, and no history holds a tool call without its result.
2. Every request has one owner. No request ends a turn, resumes an ended turn, or starts a turn.
3. Every event of one request carries the requesting turn's `turnId`, and a `taskId` exactly when a
   task owns it.
4. A gated call runs only in its gate task, after every request it raised is answered.
5. The approval policy runs once per call, at the gate. The response policy runs once per answer,
   where the session accepts it.
6. Only a person's answer grants. Model output never answers a request.

## Where each piece lives

| Piece        | Where                                                                                          | What changes                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Gate         | Where deferred calls are collected today (`collectDeferredCalls`, `harness/tool-loop.ts:2855`) | One new outcome: start a gate task                                           |
| Gate task    | A framework-provided `task()` body on public workflow API, like `ask_question` and `sleep`     | New. It asks with `ctx.ask` or `requireAuth`, then runs the tool's `execute` |
| Budget check | `enforceSessionUsageLimit`, before every model call                                            | Parks the turn on the session inbox instead of ending it                     |
| Answers      | The session inbox, the route `ctx.ask` answers take                                            | The response policy runs here, before the answer reaches its owner           |

## What this removes

- The harness approval interpreter: `harness/approval-delivery-coordinator.ts`,
  `harness/pending-input-batches.ts`, `harness/hitl/approval-input-requests.ts`.
- `hasTailApprovalResponse`, the tail guard in `harness/current-messages.ts`, and the preamble
  reordering for approvals.
- The AI SDK's `toolApproval` path for eve tools.
- Every park site that ends a turn: approvals and plain-tool sign-ins (`harness/tool-loop.ts:2715`,
  `:2771`) and budget questions (`harness/session-limit-enforcement.ts:112-152`), plus the path that
  records a message while a batch is pending and ends the turn again (`harness/tool-loop.ts:877-940`).
- `authorization-resume`, challenges that survive intervening turns
  (`execution/session/program.ts:332-343`), and `projectCompletedSiblingCalls`.
- The second HITL interpreter: approvals leave harness session state.

## Accepted costs

1. **Other principals wait.** Another person's message queues behind a held turn. This is the task
   model's accepted cost (`research/eve-tasks.md` §11, risk 4); "one open turn per principal" is its
   first follow-up and covers these turns too.
2. **Withdrawal is the model's call.** A missed `task_cancel` leaves a request the person can still
   deny. It never runs a call without an answer.
3. **The receipt can be misread.** A model may report a gated action as done early. The receipt text
   and guidance address it.
4. **One more model step and one workflow run per gated call** (`research/eve-tasks.md` §11, risks 1
   and 6). Calls that need no person pay nothing.
5. **Rich outputs become text.** A task result renders files as `[file: name]`
   (`execution/tasks/render.ts` `renderModelOutputText`). This applies to every task on `main`;
   fixing it there fixes gated calls.
6. **Long turns.** Turn duration and trace spans include time waiting for a person.

## Migration

Pre-1.0: breaking, no dual path. On load, eve settles each approval parked under the old model as
withdrawn: it writes the held-back call with a result saying the approval expired in an upgrade, and
drops the `[Pending approvals]` note. Open plain-tool challenges and budget questions from before the
upgrade are dropped the same way; the next call or model step raises a new one.

## Alternatives considered

- **Hold the call back and answer steering without it.** The model does not know its own call is
  pending, and writing the call and its result later puts them after messages they came before. That
  is history stitching.
- **Withdraw an approval on any new message** (the `ask_question` approach). Keeps one turn and
  append-only history, but a person cannot talk while an approval is open.
- **Hold the turn and queue every message.** Keeps the request open but locks the conversation until
  someone answers (#3494).
- **Make the budget question a task too.** A task starts from a tool call: its record is committed
  with the call and `task.started` names it (`research/eve-tasks.md` §7). A budget question has no
  call, must not wake the model on steering, and cancels the whole turn when declined. Each is a
  special case in the task model, to save one optional `taskId`.
- **Let the model answer requests from messages.** Handles phrasing that exact matching misses, but
  the model would approve its own call, and tool output could produce the grant.
- **Channels translate text into `inputResponses`; the core stops parsing.** Duplicates today's
  matcher in every text channel and breaks custom channels without warning.
- **Keep SDK approvals and centralize the tail guard** (#2344, closed), or **unify pending state
  first** (#2652, #2822, #2863, #3575). Both keep the call without a result and the turn-ending
  resume.

## Open questions

1. **Plain and MCP tools inside a gate task.** Can a tool's `execute` and its `ToolContext`
   (`getToken`, `session`) run from a workflow step, or is an in-session runner needed? The spike
   answers this first.
2. **Response policy at acceptance.** #3929 (open) authorizes `ctx.ask` answers with policy steps. If
   it lands, gated calls use it instead of a check of their own.
3. **Text answers for policy-guarded requests.** A text answer could carry the message's principal
   through the response policy like a structured answer. Decide whether to allow it.
4. **Credential lifetime.** Whether turn-scoped tokens fetched before a long wait are refreshed when
   the gate task runs the call.

Follow-ups, not needed for the first version: one `input.requested` per step for several gated calls,
and default request deadlines in shared threads (reusing `expireApprovalCandidates`).

## Validation

A spike with one approval-gated plain tool, one sign-in-gated plain tool, and a budget question. It
passes if:

1. The reproductions for #3899, #2826, and #3594 pass with `hasTailApprovalResponse` and
   `approval-delivery-coordinator.ts` deleted.
2. Every event of one approval carries one `turnId`, and the call runs under the requesting turn's
   principal and connections (the #3705 and #3760 shapes).
3. #3891's step, an approval next to a blocking workflow tool, runs the response policy for Approve
   and Cancel with no park-site flag.
4. A steering message while an approval is open gets a reply in the same turn, and the approval is
   still answerable afterwards.
5. `authorization-nonblocking` holds with `turn.waiting` in place of the first `session.waiting`.
6. A budget question holds the turn: Continue runs the pending model call under the same `turnId`,
   and Stop cancels the turn.
7. Typing `approve` answers a single open approval and does not steer; with two open, it answers
   neither and steers.

After the spike, e2e coverage in `e2e/fixtures/agent-tools-hitl/evals/` with one eval per row of the
outcome tables.
