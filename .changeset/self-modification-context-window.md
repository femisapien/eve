---
"eve": patch
---

The self-modification subagent now inherits a Gateway-routed parent model's context window, so it stays available on unlisted AI Gateway models instead of logging `Cannot select model "<id>" because AI Gateway did not provide context window metadata`. Dynamic resolvers can read the effective model's window and routing from `ctx.model.contextWindowTokens` and `ctx.model.routing`.
