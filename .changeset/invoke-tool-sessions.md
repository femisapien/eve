---
"eve": patch
---

Route handlers can run one of the agent's tools outside a conversation with `invokeTool(name, input, options)`. Each call runs in a tool session named by the caller, its forwarder, and an optional key, so calls with the same key reuse one sandbox. Approval and sign-in come back as `approval-required` and `authorization-required` results for the caller to retry, instead of parking a turn.
