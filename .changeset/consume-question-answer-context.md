---
"eve": patch
---

Consume channel context and state alongside plain-text answers to pending `ask_question` and `ctx.ask()` questions. Channels such as Telegram and Slack no longer leave answer metadata behind to steer the waiting turn or start an extra turn.
