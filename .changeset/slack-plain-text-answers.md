---
"eve": patch
---

Fix plain-text Slack replies to pending `ask_question` and `ctx.ask()` questions so answers contain only the person's text, not Slack metadata. For ordinary messages, sender attribution and thread history remain available to the model as context.
