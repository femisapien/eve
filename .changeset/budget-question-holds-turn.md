---
"eve": patch
---

A session-limit continuation prompt now holds the turn open like a sign-in or approval: the stream emits `turn.waiting` with `on: "input"` instead of `turn.completed` and `session.waiting`, Continue runs the pending model call in the same turn, and Stop cancels that turn with one `input.resolved`. A message sent while the prompt is open is received at once and read after Continue, and a text reply answers the prompt only when no other request is open.
