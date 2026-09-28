---
"eve": minor
---

The default message reducer gives assistant text and reasoning parts a stable `id` across streaming, completion, and replay, and keeps late-arriving participant messages ahead of their turn's response. Authorization parts track each attempt and add a `pending` state while eve waits for a callback-backed grant, so render `pending` like `required` to keep the sign-in link visible; replayed tool events no longer reopen a settled approval, and rejected tool results render as denied.
