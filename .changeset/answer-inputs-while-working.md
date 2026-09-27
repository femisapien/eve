---
"eve": patch
---

`EveAgentStore` and `useEveAgent` accept answers to open input requests while a turn is running, so the second approval of a batch stays answerable while the first answer settles. Answering a request that is already answered now rejects immediately instead of waiting indefinitely, and an answer that never reaches the server reopens its request. The web chat scaffold keeps approvals clickable while the agent works and no longer re-enables an approval that has already settled; the `eve dev` terminal prompts for approvals and questions as soon as they arrive.
