---
"eve": patch
---

Session streams state more of what readers used to infer, on stream version 27: `authorization.required.callIds` names the calls a sign-in stopped, each settled `cancelled` with `AUTHORIZATION_REQUIRED`; a sign-in callback's completion arrives before the turn it resumes; a policy's automatic denial reports `rejected` like a person's; `turn.started.continuesTurnId` names the turn a resumed turn continues, `null` for a fresh one; and approved resolutions carry `resumeTurnId`.
