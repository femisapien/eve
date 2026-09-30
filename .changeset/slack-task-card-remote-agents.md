---
"eve": patch
---

`task.agent.work()` in a Slack `taskCard` now also covers remote subagents: eve reads the remote agent's session from its own deployment, with the same credentials it calls the agent with.
