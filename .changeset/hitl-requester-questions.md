---
"eve": patch
---

Workflow tools can pass `answerableBy: "requester"` to `ctx.ask` so only the person whose message led to the call can answer, with a button or plain text; anyone else's answer is ignored and the question stays pending. `input.requested` names that person as `answerableBy`.
