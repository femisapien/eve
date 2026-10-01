---
"eve": patch
---

A tool call that needs a person's approval now runs as a task: the model gets a receipt at once and the turn stays open, the call runs once someone approves, and its result reaches the model in the same turn. This works for authored tools, workflow tools, and declared connections; calls to dynamic tools, built-in tools, agents, runtime-resolved connections, or approvals with a `response` policy that need a person are denied with a reason the model can read.
