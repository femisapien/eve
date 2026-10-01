---
"eve": patch
---

Fix plain-text Slack replies to pending questions and tool approvals without changing Slack's model-visible message envelope or bypassing approval response policies. Channels can supply `answerText` on `from(address).send()` to match the person's reply separately from message formatting.
