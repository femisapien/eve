---
"eve": patch
---

Queued messages behind a session-limit continuation prompt now start a valid waiting turn instead of emitting an unpaired `turn.waiting`. The queued message is acknowledged once, and approving the prompt resumes that turn without announcing the message again.
