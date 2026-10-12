---
"eve": minor
---

`defineDynamic` now takes `select`, with `render`, `record`, or both, instead of an `events` map. `select` reads what the value depends on, synchronously, and `render` makes the value from it. When there's something to await, `record` runs once per new selection, eve keeps the JSON it returns, and `render` makes the value from that. `once`, `perTurn`, and `perStep` name the common selections.

- **Values are evaluated before each model call,** with the conversation that call reads, and fix its model, tools, and context. A fresh process renders from what was recorded and never records again.
- **`render` is synchronous, and runs outside the session's context.** So does `record`, which reads the conversation with `await ctx.messages()`. Reading session state in either throws: read it in `select`.
- **Tools and connections are always rendered,** since what `record` returns must be JSON. `defineDurableCallback` and `defineDurableSchema` are gone: `render` returns ordinary tools.
- **A dynamic model is a `model` field.** Use `defineDynamic` from `eve/models`, or `auto()`, which decides once per turn. `agent.ts` itself can't be dynamic; a whole subagent can, with `defineDynamic` from `eve`.
- **Hooks take `select` with `run`, or `events` handlers.** `run` acts once for each new selection. Both return `cancel(reason?)` or `compact({ reason? })` from `eve/hooks`, which act once per occurrence, and `ctx.occurrence.id` keys a side effect that must happen once. `ctx.cancel()` is gone.
- **An unhandled error fails the turn.** That includes a hook's: one that only observes catches its own errors. A value that fails isn't recorded, and the next model call evaluates it again.
- **A new deployment evaluates every value again,** data and code alike, before the next model call.
- **A user-role dynamic instruction joins the conversation once per occurrence,** as a `turn.started` handler's did.
- **A call that waits, such as for approval, fails if its dynamic tool changed** since the model was offered it.
- **Dynamic remote agents carry `auth` and `headers`** from `render`. A child keeps the record it was opened with: every later request to it renders its credentials from that record, and only for the destination it was opened at.
- **A dynamic subagent that runs the parent's model** gets the parent's context-window metadata for it, so a custom parent model works without repeating `modelContextWindowTokens`.
- **A selection is at most 64 KB, and a record at most 1 MB.**
- **Memory drops its compaction hooks and `visibility`.** Recall applies to each model call.
- **Extensions with dynamic capabilities, subagents, connections, or hooks must be rebuilt** with this eve: those contracts drop their earlier epochs.
