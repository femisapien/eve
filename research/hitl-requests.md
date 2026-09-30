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
| gated call      | A tool call whose approval policy returns `"user-approval"`, or that asked for a sign-in while it ran                                        |
| gate task       | The task eve starts for a gated call. It owns the call's requests and runs the call once they are answered                                   |
| receipt         | The gated call's tool result, written at once: "Task t1 is waiting for approval to run send_email. It has not run."                          |
| task result     | The `task.result` message that later carries the call's real outcome to the model                                                            |
| budget question | The session-limit continuation request (`createSessionLimitContinuationRequest`), raised before a model call when the session is over budget |
| response policy | The tool's answer-time `approval.response`, deciding whether a responder may approve or cancel                                               |

## Motivation

### How it works today

An approval ends the turn while the tool call has no result, and eve holds the call back. The answer
starts a new turn. That turn rebuilds context and writes the call back into history, followed by the
AI SDK's approval response. The SDK runs the call only if that response is the last message
(`collectToolApprovals`, `ai@7.0.105` `dist/index.js:2936`). Plain-tool sign-in also ends the turn.
It removes the interrupted call from history (`harness/inline-tool-authorization.ts:62-89`) and
resumes from the callback in a new turn with no user message (`execution/session/program.ts:332-343`).
A budget question ends the turn too (`harness/session-limit-enforcement.ts:146`).

Each request kind has its own park and resume path. Approvals live in harness session state.
Questions, child requests, and workflow sign-ins live in the execution layer's route map.

### The record

From 2026-08-20 to 2026-09-30:

- **46 HITL issues** were filed, and 27 are still open. They cover tool approvals, `ask_question`
  and `ctx.ask`, budget questions, sign-ins, and how each is relayed, shown, and resumed.
- **About 40 HITL pull requests** were opened. 26 are bot-written fixes, and 20 of those were still
  unmerged on 2026-09-29.
- **87 commits** on `main` touched HITL files: 60 from 08-29 to 09-28, and 27 more by 09-30.
  `harness/tool-loop.ts` was touched by 55 commits since 08-29 and is now 3,356 lines.
- **The same failure keeps coming back.** Seven distinct issues, plus one duplicate, come from a
  message landing after an approval response or next to a waiting call. The approval is dropped, or
  the provider rejects the request and the session ends. Each was fixed with a guard at one site
  (#2656, #2919, #3595, #3903), and the next writer broke it again.

### The issues, by cause

The question for each issue is whether this design prevents it by construction, with no guard or
special case added for it, whether or not it has since been patched on `main`. Of the 46 issues,
28 are prevented and 18 are not.

| Cause                                                                                                                     | Prevented by design                                    | Not prevented                                                                      | Why                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **A message lands after the approval response**, so the approval is dropped or the provider rejects a call with no result | #2594, #2699, #2826, #2874, #3594, #3771, #3899, #3943 |                                                                                    | History is append-only, and a call is written together with its result or receipt. No message has a position it must keep                                                                                                                                                                        |
| **Resume loses turn context**: the turn id, the answering principal, turn-scoped connections, or a user message           | #3705, #3760 (and #3771 above)                         |                                                                                    | The answer continues the same turn, so nothing is rebuilt                                                                                                                                                                                                                                        |
| **Several approvals wait on each other**: one batch resolves per step                                                     | #3494, #3711, #4024                                    |                                                                                    | There are no batches. Each gated call has its own task and runs when its own request is answered                                                                                                                                                                                                 |
| **A message is misread** as an answer, a dismissal, deferred input, or a new turn                                         | #2466, #2469, #3421 (and #2699, #3494, #3711 above)    | #3680, #4035                                                                       | One classifier handles every delivery in one order, and an open approval no longer changes how the model is called (#2466 and #2469 came from restricting tools while one was open). #3680 needs text to answer policy-guarded requests (open question 3). #4035 is how free-text questions work |
| **Pending state is split**, and cancel, steer, or settle clears only part of it                                           | #2442, #3414, #3458, #3887 (and #2874 above)           |                                                                                    | One route table holds every open request, and cancel withdraws all of it. The harness store where #2442 and #3414 went stale is gone. A task's sign-in keeps the parent's turn open, so the next turn that dropped it in #3887 never starts                                                      |
| **Child and task relays drift** from the root path                                                                        | #2520, #3589, #3784, #3990 (and #3458 above)           | (#3680 above)                                                                      | Relayed requests use the same route table, settle events, publication path, and "nobody can answer" rule as local ones (see Stream events)                                                                                                                                                       |
| **Events are missing or not reduced**, so clients and channels get stuck                                                  | #3757, #3911 (and #2520, #3705, #3784, #3990 above)    | #2421                                                                              | Every park emits `turn.waiting`, and approval state has one source, the `input.*` events. #2421 is how concurrent sign-in attempts supersede each other                                                                                                                                          |
| **Policy and identity gaps**                                                                                              | #3198, #3891                                           | #3238, #3822, #3906                                                                | A gated call runs only after its request is answered, and the response policy runs in one place. #3238 is a choice of default, and #3822 and #3906 ask for identity the policy can't see yet                                                                                                     |
| **Outside this design**                                                                                                   |                                                        | #2319, #2471, #2476, #2779, #2806, #2845, #3103, #3497, #3546, #3615, #3712, #3895 | Channel rendering, configuration, durability, budget arithmetic for delegated sessions, scoped approval keys, and packaging                                                                                                                                                                      |

### Two root causes

The first three rows share one cause: a tool call waits without a result. The AI SDK will only run
it if the approval response is the last message. The defenses are `hasTailApprovalResponse`, called
from two sites (`harness/current-messages.ts:57`, `harness/input-requests.ts:124`), and a preamble
reordering whose comment names the constraint ("so an approval response stays in the final tool
message, where the AI SDK reads it"). Any other writer can still break it. #3983 added another
writer that has to respect it, and its PR leaves a known case open: a provider failure after an
approval resume drops the approval exchange.

The rest share the other cause: requests live in two stores, answers are classified by two
functions, and sign-ins resume through a third path (see One route). A fix on one path doesn't reach
the others. #3891 is the clearest case. One park site omitted the response-policy flag, so the
policy was skipped when an approval parked next to a workflow call. #3954 fixed that site, and every
new park site still has to remember the flag.

Gated calls remove the first cause: every waiting call has a result at once. Moving approvals and
budget questions into the store and classifier that questions already use removes the second.

## Requests and owners

### One route

Today requests are stored and answered in three places:

| Request                                                                                     | Stored in                                                                                       | Answer classified by                                                            | Text answers                                                         |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Approval, root budget question                                                              | The harness's pending-input batches (`harness/pending-input-batches.ts`)                        | `resolveTextMessageInput` and `routePendingInput` (`harness/input-requests.ts`) | Every open request the text matches; policy-guarded requests skipped |
| `ctx.ask` question (including `ask_question`), child request, relayed child budget question | The session's route table, `eve.runtime.proxyInputRequests` (`harness/proxy-input-requests.ts`) | `routeDeliverPayload` (`subagents/hitl-proxy.ts:135`)                           | Only when exactly one question is open                               |
| Plain-tool sign-in                                                                          | Authorization attempts, resumed by `authorization-resume` (`execution/session/next-input.ts`)   | The callback                                                                    | None                                                                 |

Sign-ins inside a workflow body take a second sign-in path, inside the workflow step
(`execution/tools/workflow/step-execution.ts`), and never end the turn.

Under this design:

| Request                    | Stored in                                                                                            | Answer classified by                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Approval                   | The route table, as a `ctx.ask` question from the gate task                                          | `routeDeliverPayload`                       |
| Budget question            | The route table, as a new turn-owned entry. The table already carries relayed child budget questions | `routeDeliverPayload`                       |
| Question, child request    | The route table, unchanged                                                                           | `routeDeliverPayload`, unchanged            |
| Sign-in, plain or workflow | The workflow step, from the gate task or the body                                                    | The callback, unchanged for workflow bodies |

The harness's pending-input batches, their classifier, the approval coordinator, and
`authorization-resume` are deleted. What is left is one table and one classifier for every request
a person answers, and one sign-in path.

Every delivery goes through that classifier in the same order:

1. **Answers.** Each `inputResponses` entry goes to its request's owner, after the response policy.
   An answer never steers.
2. **Text answers.** When exactly one request is open, a text message from the turn's principal
   that matches one of its options answers it and is consumed. A question that accepts free text
   takes any text (#4035). This is the rule `routeDeliverPayload` already applies to questions.
3. **Steering.** Any other message from the turn's principal steers the held turn.
4. **Everyone else.** A message from another principal waits for the turn to end.

Cancel withdraws every entry in the table, as `withdrawWorkflowAsks`
(`execution/tools/workflow/withdraw-step.ts:71`) already does for questions.

### Owners

The session alone accepts or withdraws an answer, as it already does for `ctx.ask`
(`research/eve-tasks.md` §7, "One inbox per run"). The owner is what continues once it does.

| Owner          | Requests                                                        | Continues on answer                                       | Carries `taskId`                                |
| -------------- | --------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- |
| Gate task      | Approval, sign-in for a tool call                               | The task runs the call; the task result reaches the model | Yes                                             |
| `execute` call | `ask_question`, `ctx.ask`, `requireAuth` inside a workflow body | The call's body, as on `main`                             | Only when the body runs as a task, as on `main` |
| Turn           | Budget question                                                 | The model call the turn was about to make                 | No                                              |

**The held turn.** A turn stays open while it has a working task or an open request it owns. eve
calls the model only when there is something new to read and no budget question is open. Between
calls the turn is parked (`turn.waiting`) and costs nothing.

These rules apply to every owner:

| When                                                                | Then                                                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The turn's principal sends a message that is not a text answer      | It steers the turn. Approvals and sign-ins stay open; an `execute` call's question is withdrawn, or answered when it accepts free text, as on `main` (#4035); during a budget question the message is saved for after Continue |
| Another principal sends a message                                   | It waits for the turn to end                                                                                                                                                                                                   |
| The session is cancelled, the turn fails, or the session ends       | Every open request is withdrawn (`input.resolved` `cancelled`)                                                                                                                                                                 |
| An answer or callback arrives for a withdrawn or answered request   | It is stale and changes nothing                                                                                                                                                                                                |
| Nobody can answer (a schedule, or a session without `requestInput`) | The request resolves `unavailable` at once                                                                                                                                                                                     |
| A child session raises a request                                    | The child holds its own turn; the request travels up the owner chain and the answer routes down by `requestId`, as child questions do today                                                                                    |

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

| What happens                                                                     | Result                                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| The approval policy returns `"approved"` or `"not-applicable"`                   | The call runs right away. No task, no receipt                                                                   |
| The approval policy returns `"denied"`                                           | The call does not run; its result says it was denied                                                            |
| The person denies                                                                | `t1` settles `completed`; the task result says the call was denied and did not run                              |
| The response policy rejects whoever answered (Approve or Cancel, as since #3954) | The request stays open for someone else                                                                         |
| The tool asks for a sign-in while it runs                                        | The call becomes gate task `t1`, which runs the tool again once the person signs in (see How a gated call runs) |
| The sign-in fails or times out                                                   | The task result says the call did not run, and why                                                              |
| The call needs an approval and a sign-in                                         | The approval comes first; the sign-in only comes up once the approved call runs                                 |
| One step makes several gated calls                                               | One gate task per call. Each call runs as soon as its own requests are answered                                 |
| The model calls `task_cancel(t1)`                                                | `t1`'s requests are withdrawn; the call never runs                                                              |
| A late sign-in arrives after withdrawal                                          | The credential may be stored; the withdrawn call never runs                                                     |

Everything else a gate task does is the task model on `main`: it counts toward the task cap, the
turn cannot end while it works, and `final_output` returns the error naming working tasks.

### Walkthrough

Alice asks the agent to email a report, then keeps talking while the approval is open.

| #   | What happens                                                                                   | The model reads                                | The model does                                   | Events                                                  |
| --- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| 1   | Alice: "email the report to Bob"                                                               | Her message                                    | Calls `send_email`                               | `turn.started turn_1`                                   |
| 2   | eve gates the call and starts `t1`                                                             | The receipt: waiting for approval, has not run | Replies "I've asked for approval."               | `task.started t1`, `input.requested t1`, `turn.waiting` |
| 3   | Alice: "also, what's on my calendar?"                                                          | Her message                                    | Calls `calendar.list`, then replies with her day | `turn.waiting`                                          |
| 4   | Alice clicks Approve. The session checks the response policy and passes the answer to `t1`     | Nothing; the model is not called               |                                                  | `input.resolved t1 approved`                            |
| 5   | `t1` runs `send_email` with the model's original input, and its result becomes the task result | The task result: sent                          | Replies "Sent the report to Bob."                | `task.settled t1 completed`, `turn.completed turn_1`    |

Every event carries `turn_1`. The turn ends at row 5 because nothing is working anymore.

### How a gated call runs

Two things can stop a tool call before it runs, and eve learns about them at different times:

- **An approval** is known before the call runs: the tool's `approval` policy returns
  `"user-approval"`.
- **A sign-in** is known only while the call runs: the tool asks for a token with `getToken` or
  `requireAuth`, and there is no credential yet.

#### Approvals

| Stage    | Today                                                                                                                                                                                                   | Under this design                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decide   | During `generate()`, the AI SDK calls eve's `toolApproval` callback (`buildToolApproval`, `harness/tools.ts`), which runs the tool's `approval` policy                                                  | eve runs the same policy itself when the model step returns the call. The policy gets the same context: `toolName`, `toolInput`, `callId`, and `approvedTools`  |
| Ask      | The SDK adds an approval part to the call. eve holds the call back, records a pending batch, emits `input.requested`, and ends the turn                                                                 | eve starts `t1` and writes the receipt. `t1` asks with `ctx.ask`, which emits the same `input.requested`: kind `tool-approval`, options Approve and Deny        |
| Answer   | The approval coordinator runs the response policy with the requester (`request.principal`) and the decision (`response.decision`). The policy can ask the responder to sign in (`ApprovalResponseAuth`) | The session runs the same response policy, with the same inputs, before it accepts the answer. A sign-in the policy asks for is raised before the answer counts |
| Remember | An approved tool is recorded in `eve.runtime.hitl.approvedTools`, which `once()` reads                                                                                                                  | Same record, written when the session accepts an Approve                                                                                                        |
| Run      | The SDK runs `execute` inside the next `generate()`, and only if the approval response is the last message                                                                                              | `t1` runs `execute` in a workflow step                                                                                                                          |

The built-in policies keep their meaning: `always()` always asks, `never()` never asks, `once()` asks
until the tool has been approved once in the session, and `auto()` asks its evaluation model at the
Decide stage.

#### Sign-ins

| Stage  | Today, plain tool                                                                                                                                            | Today, workflow body                                                    | Under this design                                                                                                                                                      |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Detect | The tool asks for a token with no credential. Its result carries an authorization signal (`readAuthorizationSignal`, `harness/inline-tool-authorization.ts`) | The same, inside a workflow step (`withWorkflowStepAuthorization`)      | The same. A plain tool still runs in the model step and finds out there                                                                                                |
| Ask    | eve emits `authorization.required` with the sign-in URL or code, removes the call from history, and ends the turn                                            | eve emits `authorization.required`; the run suspends and the turn waits | eve writes the receipt and makes the call gate task `t1`, which runs the tool again in a workflow step. The step raises the same `authorization.required` and suspends |
| Answer | The provider's callback; `authorization-resume` starts a new turn                                                                                            | The callback; the step runs again (`completeWorkflowStepAuthorization`) | The callback; `t1`'s step runs again. This is the workflow-body path, unchanged                                                                                        |
| Run    | The tool runs again from the start, in the new turn                                                                                                          | The step runs the tool again from the start                             | `t1`'s step runs the tool again from the start                                                                                                                         |

After a sign-in the tool runs again from the start, as it does today, so code before its `getToken`
call runs twice.

A call that needs both an approval and a sign-in gets them in that order without a special case:
`t1` asks for the approval first, and the sign-in only comes up once the approved call runs. Nobody
signs in for a call that is then denied.

#### Inside the gate task

What happens inside `t1`, from the call in walkthrough row 2 to the result in row 5. Every piece
except the gate task's body exists on `main`.

1. **Start.** The model step that made the call commits `t1`'s record alongside it and starts `t1`'s
   workflow run with the tool name, the call's input, and its `callId`, as it does for every task
   (`research/eve-tasks.md` §7, "Start once" and "First call is free").
2. **Ask.** For an approval, `t1` calls `ctx.ask` and the run suspends. The session emits
   `input.requested` with `t1`'s `taskId`.
3. **Answer.** Alice's answer reaches the session inbox. The session runs the response policy,
   accepts the answer, records it for `once()`, emits `input.resolved`, and sends it to `t1` on the
   run's control hook (`execution/tools/workflow/messages.ts`). `ctx.ask` returns `approve`.
4. **Run.** `t1` calls the tool's own `execute` inside a workflow step, with the input from step 1.
   The step restores the requesting turn's session, auth, and connections first, as workflow tools
   already do (`buildBaseToolContext`, `execution/tools/workflow/step-execution.ts`). If the tool
   asks for a sign-in here, the step suspends until the callback and then runs again.
5. **Report.** The value `execute` returns is `t1`'s result. The session emits `task.settled`
   (`research/eve-tasks.md` §7, "Settle once").
6. **Deliver.** At the next step boundary the session writes the task result into history
   (`appendTaskContext`) and calls the model.

The gate task's body, which eve provides for every gated tool:

```ts
async task(input, ctx) {
  "use workflow";
  if (needsApproval) { // the policy returned "user-approval"
    const answer = await ctx.ask(approvalRequest(tool, input)); // steps 2 and 3
    if (answer.status !== "answered" || answer.optionId !== "approve") {
      return notRun(answer); // denied, withdrawn, or nobody to ask
    }
  }
  return await runToolStep(tool, input); // step 4; a sign-in suspends this step, then it runs again
}
```

If Alice denies, `ctx.ask` returns `deny` at step 3, the body returns a "not run" result without
calling the tool, and steps 5 and 6 deliver it the same way.

### If Alice writes something else

What the model should do if Alice writes something else in walkthrough row 3:

| Alice writes                 | The model                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------- |
| "approve"                    | Is not called. The text answers the one open request, and the flow goes on at row 5 |
| "actually, send it to Carol" | Cancels `t1` with `task_cancel` and calls `send_email` again, which starts `t2`     |
| "did it send?"               | Answers from the receipt in its history: not yet, it's waiting for approval         |

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
This is the rule `routeDeliverPayload` already applies to questions; approvals and budget questions
adopt it when they move into the route table.

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

Three rules keep events uniform across local and relayed requests:

- **One publisher.** A request's events are published once, by the session whose route table holds
  it, on the same path as every other event, so hooks and channels see them. For a relayed child
  request that is the root, whose channel showed the prompt (#2520, #3784, #3990).
- **Every park says so.** Each time a held turn parks, including after a rejected answer, it emits
  `turn.waiting` (#3757).
- **One source of approval state.** History has no approval parts, so clients read an approval's
  state only from `input.requested` and `input.resolved` (#3911).

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
7. Every request a person answers is an entry in the session's route table, and every delivery is
   classified by one function.

## Where each piece lives

| Piece        | Where                                                                                          | What changes                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Gate         | Where deferred calls are collected today (`collectDeferredCalls`, `harness/tool-loop.ts:2855`) | One new outcome: start a gate task                                                                         |
| Gate task    | A framework-provided `task()` body on public workflow API, like `ask_question` and `sleep`     | New. It asks with `ctx.ask` or `requireAuth`, then runs the tool's `execute`                               |
| Budget check | `enforceSessionUsageLimit`, before every model call                                            | Parks the turn on the session inbox instead of ending it                                                   |
| Answers      | The route table and `routeDeliverPayload`, the path `ctx.ask` answers take                     | Approvals and budget questions join it. The response policy runs here, before the answer reaches its owner |

## What this removes

- The harness approval interpreter: `harness/approval-delivery-coordinator.ts`,
  `harness/pending-input-batches.ts`, `harness/hitl/approval-input-requests.ts`.
- `hasTailApprovalResponse`, the tail guard in `harness/current-messages.ts`, and the preamble
  reordering for approvals.
- The AI SDK's `toolApproval` path for eve tools.
- The harness's answer classifier for approvals and budget questions (`resolveTextMessageInput`,
  `routePendingInput` in `harness/input-requests.ts`). `routeDeliverPayload` classifies every answer.
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

Clients change too. `useEveAgent` and `EveAgentStore` show an approval's state from the tool part's
`eve` metadata today; they move to `input.requested`, `input.resolved`, and `task.settled`.

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

Each question says what is known, what isn't, and what depends on the answer.

1. **Can a gate task run any tool?**
   - Known: a workflow tool's code already runs in workflow steps, with the turn's session, auth,
     and connections restored (`execution/tools/workflow/step-execution.ts`).
   - Not known: plain tools, MCP tools, and dynamic tools that a `turn.started` hook registers run
     inside the model step today (`TurnDynamicToolMetadataKey`, "replaced each turn"). A workflow run
     may not be able to call their `execute`, or may not have a dynamic tool's definition.
   - Depends on it: step 4 of "Inside the gate task". If a workflow step can't run them, gated calls
     need a runner inside the session instead.
   - How to answer: the spike, with one plain, one MCP, and one dynamic tool behind an approval.
2. **Where does the response policy run?**
   - Known: today the approval coordinator runs it before an answer counts. The route table has no
     policy step, so as it stands an answer from anyone would count. #3929 (open) adds policy checks
     to `ctx.ask` answers.
   - Not known: whether #3929 lands in a shape gate tasks can use.
   - Options: use #3929, or have the session look up the tool's `approval.response` for gate requests
     only.
3. **Should text answer an approval that has a response policy?**
   - Known: today only a structured answer can settle such an approval, never text. Linear always
     sends replies as text, so those approvals can't be answered from Linear (#3680).
   - Option: treat a text answer like a structured one, with the message's sender as the responder,
     and run the policy on it.
   - Not known: whether every text channel identifies the sender well enough to act as a responder.

Follow-ups, not needed for the first version: one `input.requested` per step for several gated calls,
and default request deadlines in shared threads (reusing `expireApprovalCandidates`).

## Validation

A spike with an approval-gated plain, MCP, and dynamic tool, a sign-in-gated plain tool, and a
budget question. It passes if:

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
