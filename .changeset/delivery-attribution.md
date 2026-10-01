---
"eve": patch
---

`respond()` and `send()` now end at the boundary that completes their own delivery, and `EveAgentStore` follows a steered message until a boundary lists it. Two answers sent without awaiting each other no longer end at each other's boundary.
