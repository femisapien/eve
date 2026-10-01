---
"eve": patch
---

Cancelling a turn, clearing the context, a sign-in, or a task or workflow run ending now reports everything it closes: each request it withdraws settles `cancelled` in `input.resolved`, and each call it stops reports `action.result` status `cancelled` with the reason in `error.code`. Before, these closed silently, so clients kept offering answers the session no longer accepted; `session.waiting` and `turn.waiting` now also list the deliveries they complete in `processedDeliveryIds`.
