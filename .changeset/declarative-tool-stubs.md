---
"eve": patch
---

Add explicitly authorized, session-scoped JSON tool stubs with argument matching and response sequences that continue across turns within the same session. eve's internal workflow recovery preserves previously recorded tool results without consuming additional responses.

Grant replacement permission with `allowToolStubs: { subjects: evalSubjects }`, using the same subject patterns as route authentication, or a custom permission callback.
