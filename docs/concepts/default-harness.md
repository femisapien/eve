---
title: "Default Harness"
description: "How eve manages model context and compaction during an agent turn."
---

The default harness runs model calls, tool calls, and context compaction. See [Built-in tools](./built-in-tools) for its model-facing tools and [Execution model and durability](./execution-model-and-durability) for checkpointing.

## Compaction

The harness compacts long sessions before they overflow the model's context window. It adds the estimated fixed envelope of the compaction checkpoint prompt before comparing the conversation with `thresholdPercent` (`0.9` by default). If the threshold is reached, eve summarizes older turns and continues.

The summary retains completed work, decisions, remaining work, and context needed to continue. On later compactions, eve passes the previous checkpoint separately without per-message truncation and replaces it with the new one. Compaction uses the active turn model unless you override it under [`compaction`](../agent-config#compaction) in `agent.ts`:

```ts title="agent/agent.ts"
export default defineAgent({
  model: "anthropic/claude-opus-5.5",
  compaction: {
    thresholdPercent: 0.75,
  },
});
```

Before summarizing, eve trims oversized older tool results. It checks whether that freed enough space against the last provider-reported input token count plus estimated new messages; if not, it summarizes older history.

First-class [memory](../memory) participates in a separate lifecycle. eve asks
providers to capture before compaction, excludes attributed recalled records
from the summarizer, keeps their canonical latest values, and recalls again
after the checkpoint.

Clients and channels can also request compaction between turns. Call
`ClientSession.compact()`, a channel route's `compact(address)`, or
`attachSession(sessionId).compact()`. The request does not append a user message;
if a turn is running, eve queues it until that turn settles. A successful manual
compaction emits the same `compaction.requested` and `compaction.completed`
events as automatic compaction, followed by `session.waiting`.

After compaction, eve moves the idle session to a fresh workflow run on the same deployment to bound run history. See [Compaction handoff](./execution-model-and-durability#compaction-handoff).

To discard model-message history instead of summarizing it, call the corresponding
`clear()` method on any of those handles. Clearing preserves the session identity,
system prompt, configured tools and skills, durable state, limits, and sandbox.
It removes recalled memory records and framework memory bookkeeping, but it
does not delete data from a memory provider's external store.
Its stream boundary is `context.cleared` followed by `session.waiting`.

## What to read next

- [Built-in tools](./built-in-tools): review the default and opt-in framework tools and configure the model-facing tool set
- [Execution model and durability](./execution-model-and-durability): understand how turns checkpoint and resume
- [Context control](./context-control): choose what the model sees and when
- [Memory](../memory): connect scoped, cross-session context to the harness lifecycle
