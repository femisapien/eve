---
issue: "TBD (no tracking issue yet; evidence issues listed under Motivation)"
status: draft
last_updated: "2026-09-30"
---

# HITL requests as tasks

## Decision

A tool call that needs a person before it can run, because it needs an approval or a sign-in, runs
as a task on the call's behalf. The call gets a receipt at once. The task waits for the person, then
runs the call, and its result reaches the model as a `task.result` message in the same turn. The
turn stays open until the task settles, and the conversation continues inside it.

A session limit is the one request that is not about a tool call. It gates the model step itself,
so it is owned by the turn instead of a task. The turn holds on it the same way, and the answer
continues the same turn instead of starting a new one.

This removes the one state in which eve's history holds a tool call without its result. That state
causes the recurring approval-resume failures (#2594, #2826, #3594, #3899, #3943) and the sign-in
resume without a user message (#3771). The design reuses the task model on `main` (#3840, #3850)
and needs no new wait, park path, or resume path.

The authoring API does not change. The observable changes are:

- an approval or sign-in no longer ends the turn; every event of one request carries one `turnId`;
- the model sees a receipt, then a `task.result`, instead of a withheld call;
- a person can keep talking while a request is open, and the request stays open;
- the model withdraws a request with `task_cancel`, not a message heuristic.

Line numbers refer to `origin/main` `66f295eb6` (2026-09-28) and `ai@7.0.105`; every symbol and
file named here still exists on `e9dd41827` (2026-09-30). Paths are relative to `packages/eve/src`
unless they start with `research/`. Since the baseline, #3928 and #3954 pass the requester to
response policies and run them for Cancel too, and #3983 gates workflow dispatch on approval. This
design keeps both behaviors.

## Terms

| Term            | Meaning                                                                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| history         | The durable `ModelMessage[]` eve stores for a session (`HarnessSession.history`)                                                                                                         |
| pair invariant  | Every tool call in a model prompt has its tool result in the tool message that immediately follows. Providers reject prompts that break it                                               |
| request         | One question eve puts to a person: an approval or a session-limit continuation (`InputRequest` with options), or an authorization challenge (sign-in). Identified by `requestId`         |
| group           | The requests raised by one model step. Presented together, answerable separately                                                                                                         |
| gated call      | A tool call whose approval policy returns `"user-approval"`, or whose tool needs a sign-in eve cannot satisfy yet                                                                        |
| gate            | eve's evaluation of the approval policy (and the credential check) for a tool call, before it runs                                                                                       |
| gate task       | The task eve starts for a gated call. It owns the call's requests and runs the call once they are satisfied                                                                              |
| receipt         | The gated call's immediate tool result, naming the gate task (`R₀`)                                                                                                                      |
| task result     | The `task.result` user-role message that carries the gate task's outcome at a step boundary (`T`)                                                                                        |
| held turn       | A turn that stays open while a task works (`research/eve-tasks.md` §6, "the turn rule")                                                                                                  |
| steering        | A message from the turn's principal arriving during a turn (`execution/session/input-queue.ts:223-234`)                                                                                  |
| owner           | What a request belongs to and what continues when it resolves: a gate task, or the turn for a session limit. A child session's requests are answered at the root through the owner chain |
| limit request   | The session-limit continuation prompt (`createSessionLimitContinuationRequest`), raised before a model call when the session is over budget                                              |
| approval policy | The request-time `ApprovalPolicy`, returning an `ApprovalStatus`                                                                                                                         |
| response policy | The answer-time `ApprovalResponsePolicy` deciding whether a responder may approve or cancel (`approval.response`)                                                                        |

Message symbols used below:

```text
U   user("email the report to Bob")
C   assistant(toolCall c1 send_email)
R₀  tool(c1 → receipt "Task t1 is waiting for approval. send_email has not run.")
U₂  user("also, what's on my calendar?")                     // steering during the hold
M₂  assistant("You have …")                                  // reply to U₂, inside the same turn
T   user-role <task_result t1 …>                             // the gated call's real outcome
M   assistant("Sent the report to Bob.")                     // final reply
```

## Motivation

Today an approval ends the turn with the tool call withheld and no result. The answer arrives as a
new delivery, which starts a new turn that has to rebuild context and put `C` back into history,
followed by the AI SDK's approval response, which must be the last message for the SDK to run the
call (`collectToolApprovals`, `ai@7.0.105` `dist/index.js:2936`). Plain-tool sign-in ends the turn
too, removes the interrupted call from history (`harness/inline-tool-authorization.ts:62-89`), and
resumes from the callback in a new turn with no user message (`execution/session/program.ts:332-343`).

This produces five failure classes:

1. **Tail order.** Any framework message written after the approval response drops the approval:
   skills (#2826), `clientContext` (#3594), memory recall with turn instructions (#3899, #3943),
   sign-in resume (#3771), a second park (#2594). The defenses are `hasTailApprovalResponse`
   (`harness/current-messages.ts:57`, `harness/input-requests.ts:124`) and a preamble reordering
   whose comment names the constraint ("so an approval response stays in the final tool message,
   where the AI SDK reads it", `harness/tool-loop.ts`, before the first model step). #3983 adds
   another writer that has to respect it: workflow results now join the approval message so the SDK
   resumes approved siblings. Its PR leaves one known case open, a provider failure after an
   approval resume that drops the approval exchange.
2. **Resume context.** The approving turn rebuilds the turn id, principal, and turn-scoped
   connections (#3705, #3760, #3751). One approval spans the turn ids `""`, `turn_1`, `turn_2`.
3. **Single tail.** Only one tool message can be last, so one approval group resolves per step
   (#3711, #3564).
4. **Park-path divergence.** Each park site builds its own pending state. One omitted the
   response-policy flag, so the response policy was skipped when an approval parked next to a
   deferred workflow call (#3891: `harness/tool-loop.ts:2647` vs `:2691`). #3954 fixed that site;
   every new park site still has to remember the flag.
5. **Split interpreters.** Approvals live in harness session state; questions, child requests, and
   workflow sign-ins live in the execution layer's route map.

Tasks already have the semantics these cases need. A task call's receipt is its tool result, so the
pair invariant holds at once. No turn ends while a task works, the turn's principal keeps steering
it, answers are routed to the task instead of steering, and results arrive in the turn that started
the work (`research/eve-tasks.md` §2, §6, §7).

## Authoring API

Unchanged:

- A tool declares `approval` as an `ApprovalPolicy` or `{ request, response? }`. `auto()`, `once()`,
  `always()`, and `never()` keep their meanings.
- Connections keep `requireAuth` and `getToken`.
- `ask_question` stays an `execute` call built on `ctx.ask`.

What changes is who evaluates the policy. eve evaluates the approval policy in the gate and no
longer passes it to the AI SDK as `toolApproval`. The SDK never sees an approval-gated tool.

## Semantics

### Which requests become tasks

| Kind                                              | Primitive                                      | During the request                                                                        | Withdrawn by                                   |
| ------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Tool approval                                     | Gate task                                      | The conversation continues in the held turn                                               | `task_cancel`, `session.cancel()`, session end |
| Sign-in needed by a tool call                     | Gate task                                      | The conversation continues in the held turn                                               | Same                                           |
| Sign-in inside a workflow or task body            | Unchanged: `requireAuth` waits inside the body | As today                                                                                  | As today                                       |
| Question (`ask_question`, `ctx.ask` in `execute`) | Unchanged: `execute` call                      | Steering withdraws it; the message can be the answer                                      | Steering, cancel                               |
| Session limit                                     | Limit request owned by the turn                | The turn holds. Messages are recorded and wait for the answer, since the model cannot run | `session.cancel()`, session end                |

Only a gated call becomes a task. A call the gate lets through runs as it does today, with no
receipt and no extra model step.

### Lifecycle of a gated call

```text
model step → tool call c1 → gate
  "approved" | "not-applicable", credentials present → run c1 in the step → C + R
  "denied"                                           → C + D            (D: execution-denied)
  "user-approval" or sign-in needed                  → start gate task t1 → C + R₀ → turn holds
      t1 raises its requests → input.requested / authorization.required { turnId, taskId }
      approval answered approve → response policy at acceptance
          allowed  → t1 runs c1 → task.settled completed → T (result)
          rejected → the request stays open
      approval answered deny                   → task.settled completed → T (denied, not run)
      sign-in completes                        → t1 runs c1 → T (result)
      sign-in fails or times out               → task.settled completed → T (not run, reason)
      task_cancel / session.cancel()           → requests withdrawn → task.settled cancelled
```

A gate task for an approval that also needs a sign-in raises the approval first and the sign-in only
after the approval is accepted. That way a person is not asked to sign in for a call they then deny.

### Lifecycle of a limit request

```text
held turn wants a model step → usage limit check (before every model call)
  within budget                         → model step
  over budget, nobody can answer        → turn fails SESSION_TOKEN_LIMIT_REACHED     (as today)
  over budget, zero inherited window    → child fails; its parent reaches the limit  (as today)
  over budget, requestInput             → limit request L1 → input.requested { turnId } → turn.waiting
      grant   → bump the budget window → the same model step runs, same turnId
      decline → the turn tree is cancelled → turn.cancelled                           (as today)
      message from the turn's principal → recorded in history; L1 stays open
      session.cancel()                  → L1 withdrawn → turn.cancelled
```

The limit check runs wherever the turn is about to call the model, including after a steering message
or a `T` during a hold. A turn can therefore hold on gate tasks and a limit request at once. The
turn continues only when its limit request is resolved, and ends only when its gate tasks settle.

A limit request is not a task: there is no call to put a receipt on, and a task's hold wakes the
model on steering, which a limit forbids. It uses the same request route, the same session authority
over answers, and the same held turn as a gate task.

### Example

```text
Delivery 1   POST /eve/v1/session { message: U }
  turn.started { turn_1 }  step.started { turn_1, 0 }
  generate([U]) → C                                    // plain tool call; no approval part
  gate: user-approval → task t1 starts
  task.started   { turn_1, taskId: t1, callId: c1 }
  step.completed                                       history [U, C, R₀]
  input.requested { turn_1, taskId: t1, requests: [a1] }
  step.started { turn_1, 1 }
  generate([U, C, R₀]) → "I've asked for approval to email Bob."
  turn.waiting { turn_1 }                              // held: t1 is working

Delivery 2   POST /eve/v1/session/:id { message: U₂ }  // same principal → steers turn_1
  step.started { turn_1, 2 }
  generate([… , U₂]) → M₂                              // posted as "stop"; a person can keep writing
  turn.waiting { turn_1 }

Delivery 3   POST /eve/v1/session/:id { inputResponses: [{ requestId: a1, optionId: approve }] }
  input.resolved   { turn_1, taskId: t1, outcome: approved }
  approval.settled { turn_1, taskId: t1, outcome: approved }
  t1 runs send_email
  task.settled     { turn_1, taskId: t1, callId: c1, status: completed }
  step.started { turn_1, 3 }
  generate([… , T]) → M
  turn.completed { turn_1 }
  session.waiting
```

No framework message has an ordering constraint. `C` and `R₀` are adjacent from the step that made
the call, and `T` is an ordinary user-role message.

### Rules

| #   | Given                                                                                      | When                                                    | Then                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The approval policy returns `"approved"` or `"not-applicable"` and credentials are present | The model calls the tool                                | The call runs in the step; `C + R`. No task, no request                                                                                                                                                                                         |
| 2   | The approval policy returns `"denied"`                                                     | The model calls the tool                                | `C + D`. No task, no request                                                                                                                                                                                                                    |
| 3   | The approval policy returns `"user-approval"`                                              | The model calls the tool                                | Gate task `t1` starts; `C + R₀`; `input.requested` carries `taskId`; the turn holds                                                                                                                                                             |
| 4   | An open approval without a response policy                                                 | An answer `approve` is accepted                         | `input.resolved` `approved`; `t1` runs the call; its outcome arrives as `T`                                                                                                                                                                     |
| 5   | An open approval with a response policy                                                    | An answer `approve` arrives                             | The session runs the response policy before it accepts the answer. `allowed` → rule 4. `rejected` → the request stays open, `approval.candidate` `rejected` is emitted, and the answer is not consumed                                          |
| 6   | An open approval                                                                           | An answer `deny` or `cancel` arrives                    | The response policy runs with `response.decision: "cancel"`, as on `main` since #3954. `allowed` → `input.resolved` `denied`; `t1` settles `completed` with a not-run output; `T` says the call was denied. `rejected` → the request stays open |
| 7   | One step makes several gated calls                                                         |                                                         | One gate task per call. Their requests form one group. Each call runs as soon as its own requests are satisfied                                                                                                                                 |
| 8   | Requests of one group are open                                                             | One delivery answers some of them                       | Each answer is applied independently; the rest stay open                                                                                                                                                                                        |
| 9   | Any request is open                                                                        | The turn's principal sends a message                    | The message steers the held turn and the model replies. Requests stay open (tasks are untouched by steering)                                                                                                                                    |
| 10  | Any request is open                                                                        | The model calls `task_cancel({ taskId: t1 })`           | `t1`'s requests are withdrawn (`input.resolved` `cancelled`); `task.settled` `cancelled`; the call never runs                                                                                                                                   |
| 11  | Any request is open                                                                        | Another principal sends a message                       | It queues until the turn ends, then starts that principal's turn                                                                                                                                                                                |
| 12  | Any request is open                                                                        | `session.cancel()`, turn failure, or session end        | Every gate task is cancelled and its requests withdrawn                                                                                                                                                                                         |
| 13  | A withdrawn or resolved request                                                            | A late answer or callback arrives                       | It is stale and changes nothing. A late sign-in may still store the credential; it never runs the withdrawn call                                                                                                                                |
| 14  | The session cannot reach a person (a schedule, a child without `requestInput`)             | A gated call is made                                    | The request resolves `unavailable` at once; `t1` settles with a not-run output                                                                                                                                                                  |
| 15  | A child session's gated call                                                               |                                                         | The child holds its own turn; its requests travel up the owner chain and answers route down by `requestId`, as child questions do today                                                                                                         |
| 16  | Gate tasks are working                                                                     | The model tries to end the turn or calls `final_output` | As for any task: the turn holds, and `final_output` returns the error naming the working tasks                                                                                                                                                  |

| 17 | The session is over budget and can request input | The turn is about to call the model | A limit request opens with the turn's `turnId`; the turn holds (`turn.waiting`), with no `turn.completed` |
| 18 | An open limit request | An answer `grant` is accepted | The budget window is bumped and the pending model step runs in the same turn |
| 19 | An open limit request | An answer `decline` is accepted | The turn tree is cancelled, as today (`SessionLimitDeclinedError`) |
| 20 | An open limit request | The turn's principal sends a message | The message is recorded in history and the request stays open. The model sees the message after a grant |
| 21 | An open limit request and working gate tasks | A gate task settles | `T` is recorded; the model runs only after the limit request is granted |

Rules 9 to 13 and 16 are the task rules on `main` applied to gate tasks (`research/eve-tasks.md` §2,
§6, §7). Rules 4 and 5 move the response-policy check from the harness
(`harness/approval-delivery-coordinator.ts:307-341`) to the point where the session accepts an
answer.

### What the model sees

- **Receipt.** Built by `execution/tasks/render.ts` alongside `renderTaskReceipt`, with a gate-specific
  text that says the call has not run:
  `Task t1 is waiting for approval to run send_email. It has not run. Its result will arrive in a <task_result> message.`
  The sign-in variant names the connection.
- **Task result.** One `<task_result>` block per settled gate task, with the call's output, or a
  not-run reason (`denied`, `sign-in failed`, `unavailable`).
- **Tools.** `task_wait` and `task_cancel` are offered whenever the agent has an approval-gated tool,
  with the existing task guidance. The guidance adds: cancel a waiting task when the person changes
  what they want, and don't report a gated action as done before its result arrives.
- **No approval parts** and no `[Pending approvals]` note. The `[Tasks]` note lists working gate
  tasks.

### Stream events

| Event                                       | Today                                                                                                       | Proposed                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| After `input.requested` for an approval     | `turn.completed`, `session.waiting`                                                                         | `turn.waiting` (held turn)                                                    |
| `input.requested`, `authorization.required` | No `taskId`                                                                                                 | Carry `taskId` of the gate task                                               |
| `input.resolved`, `approval.settled`        | Emitted around a new turn; `approval.settled` before the preamble, with the current turn id (inferred `""`) | Same `turnId` as the request, with `taskId`                                   |
| The gated call's outcome                    | `action.result` in a new turn                                                                               | `task.started` at the call, `task.settled` at the outcome, `T` in history     |
| Answering delivery                          | `turn.started` with a new `turnId`                                                                          | No new turn; `step.started` with the same `turnId`                            |
| Sign-in callback                            | `authorization-resume` starts a new turn                                                                    | Resumes the gate task inside the held turn                                    |
| After `input.requested` for a limit         | `turn.completed`, `session.waiting` (`harness/session-limit-enforcement.ts:146`)                            | `turn.waiting`; a grant continues with `step.started` under the same `turnId` |

`send().result()`, MCP, and other response readers already stop at `turn.waiting` when requests are
pending (`client/session-utils.ts` `isTurnSegmentBoundary`), so they return `status: "waiting"` with
the open requests, as they do for questions.

## Invariants

1. The pair invariant holds at every history write. No history ever contains a tool call without
   its result.
2. A gated call runs only inside its gate task, and only after every request it raised is satisfied.
3. The approval policy is evaluated once per call, by the gate.
4. The response policy runs at answer acceptance, in one place, for every approval.
5. Every event of one request carries the `turnId` of the turn that raised it and the `taskId` of
   its gate task.
6. A turn ends only after each of its gate tasks settles, as for every task.
7. No request resumes a turn that has ended, and no request starts a turn.
8. Every request has exactly one owner: a gate task or the turn. No HITL request ends a turn.

## Architecture boundary

```text
generate() ─ tool calls ─► gate ─┬─ pass ─► run in step ─► C + R
                                 ├─ deny ─► C + D
                                 └─ gate ─► task table: start t1 ─► C + R₀ ─► held turn
session inbox ─ answer ─► accept (response policy) ─► t1's ask ─┐
             ─ callback ─► authorization attempt ────────────────┼─► t1 runs call ─► task.settled ─► T
             ─ steer ─► model step (t1 untouched)                │
             ─ task_cancel / cancel ─► withdraw ─────────────────┘
held turn ─ before each model call ─► limit check ─ over budget ─► limit request (owner: turn)
session inbox ─ grant ─► bump budget ─► model step, same turnId
```

- **The gate** belongs where deferred calls are collected today (`collectDeferredCalls`,
  `isDeferredHarnessTool`, `harness/tool-loop.ts:2855`). It adds one outcome: start a gate task.
- **The gate task** is a framework-provided `task()` body, built on public workflow API the way
  `ask_question` and `sleep` are (`research/eve-tasks.md` Summary item 7): `ctx.ask` for the
  approval, `requireAuth` for the sign-in, then the tool's own `execute`.
- **The session** stays the single authority on requests. It accepts an answer or a withdrawal at the
  step that retires the request's route (`research/eve-tasks.md` §7, "One inbox per run"). The
  response policy runs in that step, before the answer reaches the task.

## What this removes

- The harness approval interpreter: `harness/approval-delivery-coordinator.ts`,
  `harness/pending-input-batches.ts`, `harness/hitl/approval-input-requests.ts`.
- `hasTailApprovalResponse`, the tail guard in `harness/current-messages.ts`, and the preamble
  reordering for approvals.
- The AI SDK's `toolApproval` / `needsApproval` path for eve tools.
- The approval and plain-tool sign-in park sites (`harness/tool-loop.ts:2715`, `:2771`).
- `authorization-resume` and challenges that survive intervening turns
  (`execution/session/next-input.ts`, `execution/session/input-queue.ts`,
  `execution/session/program.ts:332-343`), and `projectCompletedSiblingCalls`.
- The limit park: `parkOnSessionUsageLimit`'s `PendingInputBatch` and turn end
  (`harness/session-limit-enforcement.ts:112-152`), and the path that records a message while a batch
  is pending and ends the turn again (`harness/tool-loop.ts:877-940`).
- The split between two HITL interpreters.

## Accepted costs

1. **Other principals wait.** Another person's message queues behind a held turn. This is the task
   model's accepted cost (`research/eve-tasks.md` §11, risk 4); "one open turn per principal" is its
   first follow-up and covers gate tasks too.
2. **Withdrawal is the model's call.** When a person changes what they want, the model has to cancel
   the gate task. Nothing withdraws it by rule. A missed cancel leaves a request the person can still
   deny; it never runs a call without an answer.
3. **The receipt can be misread.** A model may report a gated action as done early. The receipt text
   and task guidance address it; an ordering that must always hold still belongs in a workflow tool
   (`research/eve-tasks.md` §1).
4. **One more model step per gated call**, and one workflow run per gate task (§11, risks 1 and 6).
   Gate tasks count toward the 32-task cap (`TOO_MANY_TASKS`).
5. **Long turns.** Turn duration and trace spans include time waiting for a person. Waiting time is
   visible from `turn.waiting` and `input.resolved` timestamps.

## Migration

Pre-1.0: breaking, no dual path. Sessions parked under the old model hold a `PendingInputBatch`
with a withheld `C`. On load, eve settles each such approval as withdrawn, appends `C + D` with a
reason saying the approval expired in an upgrade, and drops the `[Pending approvals]` note. Open
plain-tool challenges from before the upgrade are dropped the same way; the next call raises a new
one.

## Alternatives considered

- **Deferred `execute` call, withdrawn on any new message** (the same approach as `ask_question`). Keeps the pair
  invariant and one turn, but any message from the person kills the approval, so a person cannot
  talk while a request is open.
- **Hold the turn and queue every message.** Keeps the request open, but locks the conversation until
  a person answers, which reintroduces #3494.
- **Keep SDK approvals and centralize the tail guard** (#2344, closed). Fixes today's writers but
  keeps the unmatched call, the turn-ending resume, and one group per step.
- **Unify pending state first** (#2652, #2822, #2863, #3575). Consolidates where approval state
  lives but keeps approval parts and the turn-ending resume. None landed; #2863 no longer rebases.

## Open questions

1. **Plain and MCP tools inside a gate task.** Can a plain tool's `execute` and its `ToolContext`
   (`getToken`, `session`) run from a workflow step, or is an in-session runner needed? This is the
   first thing the spike answers.
2. **Response policy at acceptance.** The session must evaluate `approval.response` before it
   consumes an answer. #3929 (open) authorizes `ctx.ask` responses with policy steps; if it lands,
   gate requests use it instead of a gate-specific check.
3. **Denial shape.** `task.settled` `completed` with a not-run output (proposed) or `failed`.
   Affects clients and the eval assertions.
4. **Text answers.** Today a text message matching an option can answer an approval
   (`harness/input-requests.ts:230-254`). Under this design a message steers. Proposed: channels
   that need text answers translate them into `inputResponses`; the core does not parse messages.
5. **Grouping.** Several gate tasks from one step each raise their own request. Decide whether the
   session emits one `input.requested` for the group.
6. **Messages during a limit.** Rule 20 records the message and leaves it unanswered until a grant.
   The alternative is a fixed framework reply ("waiting for budget approval") so the person sees
   that the message arrived. Decide whether channels render that from `turn.waiting` instead.
7. **Request deadlines.** Whether gate requests get a default deadline in shared threads, reusing
   approval candidate expiry (`expireApprovalCandidates`).
8. **Credential lifetime.** Whether turn-scoped tokens fetched before a long wait are refreshed when
   the gate task runs the call.

## Validation

A spike with one approval-gated plain tool and one sign-in-gated plain tool. It passes if:

1. The reproductions for #3899 (on `main`), #2826, and #3594 pass with `hasTailApprovalResponse`
   and `approval-delivery-coordinator.ts` deleted.
2. Every event of one approval carries one `turnId`, and the call runs under the requesting turn's
   principal and connections (the #3705 and #3760 shapes).
3. #3891's step (an approval plus a blocking workflow tool) still runs the response policy, for both
   Approve and Cancel, with no park-site flag.
4. A steering message while an approval is open gets a reply in the same turn, and the approval is
   still answerable afterwards.
5. `authorization-nonblocking` holds with `turn.waiting` in place of the first `session.waiting`:
   an ordinary message is answered while the challenge stays open.

6. A limit request holds the turn: a grant continues under the same `turnId`, a decline cancels
   the turn, and `harness/session-limit-enforcement.ts` no longer calls `emitTurnEpilogue`.

After the spike, e2e coverage in `e2e/fixtures/agent-tools-hitl/evals/` for rules 3 to 21, one
Given/When/Then eval each.
