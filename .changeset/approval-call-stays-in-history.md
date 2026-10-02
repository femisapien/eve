---
"eve": patch
---

A tool call waiting for approval now stays in session history, and the model is not called until every approval from that step is answered or withdrawn. eve no longer adds a `[Pending approvals]` note to history, a reply that answers only some of a step's approvals keeps the turn waiting instead of resuming the model, and cancelling a turn reports each open approval in its own `input.resolved` event.
