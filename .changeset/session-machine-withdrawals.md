---
"eve": patch
---

Cancelling a turn, clearing the context, or a task or workflow run ending now reports everything it closes: each request it withdraws settles `cancelled` in `input.resolved`, each sign-in in `authorization.completed` with `failed`, and each call it stops in `action.result` with the new `cancelled` status and `TURN_CANCELLED` or `CONTEXT_CLEARED`. Before, these closed silently, so clients kept offering answers the session no longer accepted, and `clear` left approvals answerable. A relayed question now attaches to the call it serves (`input.requested.callId`) instead of the child session's first turn. Sessions checkpointed by an earlier version keep running on their owning deployment.
