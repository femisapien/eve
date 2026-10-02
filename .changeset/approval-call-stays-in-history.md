---
"eve": patch
---

A tool call waiting for approval now stays in session history, and the model is not called until every approval from that step is answered or withdrawn. eve no longer adds a `[Pending approvals]` note to history, a reply that answers only some of a step's approvals keeps the turn waiting, and cancelling a turn reports each open approval in its own `input.resolved` event. A typed reply such as "approve" now answers only when everything open is one group: one step's approvals together, the budget question alone, or a single relayed question; otherwise it is an ordinary message.
