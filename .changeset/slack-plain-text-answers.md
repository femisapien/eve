---
"eve": patch
---

Fix plain-text Slack replies to pending `ask_question` and `ctx.ask()` questions without changing Slack's model-visible message envelope. Channels can supply `answerText` on `from(address).send()` to match the person's reply separately from message formatting.
