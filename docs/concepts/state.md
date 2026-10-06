---
title: "State"
description: "Durable per-session memory with defineState: get() and update(), persisted across step boundaries."
---

`defineState` keeps typed values such as a budget or checklist within one durable session. Values survive turns, process restarts, and redeploys. Use a [memory provider](../memory) instead when data must outlive a session.

Pass a stable, agent-namespaced `name` and an `initial` function. The returned `StateHandle<T>` has:

- `get()`: read the current value. Returns `initial()` on first access within a context.
- `update(fn)`: replace the value with `fn(current)`.

Declare the handle once at module scope and import it wherever you read or write the slot. Use it from inside a tool, hook, or other framework-managed runtime code:

```ts title="agent/lib/budget.ts"
import { defineState } from "eve/context";

export const budget = defineState("my-agent.budget", () => ({ count: 0, cap: 25 }));
```

```ts title="agent/tools/spend.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import { budget } from "../lib/budget";
import { runQuery } from "../lib/warehouse";

export default defineTool({
  description: "Run a query, counting it against the session budget.",
  inputSchema: z.object({ sql: z.string() }),
  async execute({ sql }) {
    const { count, cap } = budget.get();
    if (count >= cap) throw new Error("Query budget exhausted for this session.");
    budget.update((s) => ({ ...s, count: s.count + 1 }));
    return runQuery(sql);
  },
});
```

`get()` and `update()` require an active eve context. Calling them outside tools, hooks, or framework-managed code throws.

## Reset state between turns

State is durable by default and does not reset between turns. If you want a clean slate every turn, overwrite it from a lifecycle [hook](../guides/hooks) on `turn.started`:

```ts title="agent/hooks/reset-budget.ts"
import { defineHook } from "eve/hooks";
import { budget } from "../lib/budget";

export default defineHook({
  events: {
    async "turn.started"() {
      budget.update(() => ({ count: 0, cap: 25 }));
    },
  },
});
```

## State is never shared with subagents

Every [subagent](../subagents) starts with its own fresh state, whether it's a built-in `agent` copy or a declared specialist. `defineState` values never cross the parent/child boundary, even when the child is a copy of the same agent.

## State vs. connection-side storage

A [memory provider](../memory) stores and recalls context across sessions. Use a [connection](../connections) when the model should query external data explicitly rather than receiving it through automatic recall.

## What to read next

- Read state inside dynamic resolvers → [Dynamic capabilities](../guides/dynamic-capabilities)
- How step durability works → [Execution model & durability](../concepts/execution-model-and-durability)
- The `ctx` accessors available alongside state → [TypeScript API Reference](../reference/typescript-api)
- Tenant-scoped long-term memory with any provider → [Multi-tenant memory](../patterns/multi-tenant-memory)
- First-class recall, capture, and provider tools → [Memory](../memory)
