---
"eve": patch
---

Session streams now state the lifecycle facts readers used to guess, and report everything eve withdraws. `turn.started` carries `continuesTurnId` when it resumes an earlier turn's work, approved resolutions in `input.resolved` carry the `resumeTurnId` of the turn that runs the call, `authorization.required` names the calls it stops in `callIds`, and a request a task's run passes up names the call it serves in `callId` and uses that call's coordinates. `attemptId` is required on both sign-in events. `action.result` gains a `"cancelled"` status, with `AUTHORIZATION_REQUIRED`, `TURN_CANCELLED`, or `CONTEXT_CLEARED`, for calls eve stops, and a policy's automatic denial reports `"rejected"` instead of `"failed"`. Cancelling a turn, clearing the context, or a task's run ending emits `input.resolved` with outcome `"cancelled"`, or `authorization.completed` with outcome `"failed"`, for each request or sign-in it drops, and a sign-in callback's completion now comes before the turn it resumes.

This also fixes four cases: a step with an approval beside a call that needs a sign-in now asks for the sign-in, a sign-in no longer closes a turn whose workflow runs are still working, a response policy that settles nothing no longer starts a turn, and an approval's first decision stands.
