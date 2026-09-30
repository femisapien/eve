---
"eve": patch
---

Session streams now state lifecycle facts that readers used to guess. `turn.started` carries `continuesTurnId` when it resumes an earlier turn's approvals, session-limit prompt, or sign-in. An approved resolution in `input.resolved` carries the `resumeTurnId` of the turn that runs the call. `authorization.required` always carries `attemptId` and names the calls that asked in `callIds`. A question or approval a task's run passes up names the call it serves in `callId`, and uses that call's coordinates rather than the child session's.

`action.result` gains a `"cancelled"` status for calls eve stopped: a call that asked for a sign-in settles with `AUTHORIZATION_REQUIRED`, and a parked call stopped by a cancel or clear settles with `TURN_CANCELLED` or `CONTEXT_CLEARED`. A policy's automatic denial now reports `"rejected"` instead of `"failed"`.

The stream also reports every request eve withdraws. Cancelling a turn, clearing the context, or a task's run ending emits `input.resolved` with outcome `"cancelled"` (or `authorization.completed` with outcome `"failed"` for a sign-in) before the event that ends it. A sign-in callback's `authorization.completed` now comes before the turn it resumes.

Several fixes come with this:

- A step with both an approval and a call that needs a sign-in now asks for the sign-in.
- A sign-in asked while workflow runs still work keeps the turn open for them.
- A response policy that settles nothing no longer starts a turn and calls the model.
- An approval's first decision stands.

Channel activity reads the same facts and reports a call a failed turn cut off as `interrupted`. `eve dev` warns when a session's stream breaks these rules.
