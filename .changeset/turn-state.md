---
"eve": patch
---

Clearing a session's context now also withdraws its pending approvals, session-limit prompt, and sign-ins, so a later answer to one of them no longer runs the earlier tool call. eve now runs approved tool calls itself before the model reads their results. Sessions started on an earlier eve version cannot resume or hand off to this one; start a new session.
