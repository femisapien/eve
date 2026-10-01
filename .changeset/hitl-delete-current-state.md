---
"eve": patch
---

A plain tool call that needs a sign-in now fails with an error naming the connection, and a session that reaches its token or cost limit fails with `SESSION_TOKEN_LIMIT_REACHED` or `SESSION_TOKEN_COST_LIMIT_REACHED` instead of asking to continue. Questions asked from tools and sign-ins inside workflow steps are unchanged.
