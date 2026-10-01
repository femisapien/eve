---
"eve": patch
---

`respond()` and `send()` now end at the boundary that completes their own delivery. `session.waiting` and `turn.waiting` carry `processedDeliveryIds`, and an answer's events carry `meta.answerDeliveryIds`, including answers the session forwards to a child session or a workflow run. Two answers sent without awaiting each other no longer end at each other's boundary, and an answer that leaves the session waiting, such as a partial approval, reaches a boundary right away.
