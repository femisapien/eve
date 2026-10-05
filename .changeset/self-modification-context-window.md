---
"eve": patch
---

The self-modification subagent now inherits the parent agent's context window along with its model. Agents on a custom or unlisted model no longer log `Cannot select model "<id>" because AI Gateway did not provide context window metadata` on every session and turn, and the subagent stays available. A model configured explicitly for self-modification is unchanged. Dynamic resolvers can read the effective window from `ctx.model.contextWindowTokens`.
