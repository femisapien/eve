---
title: "Multi-Tenant Memory"
description: "Bind an eve memory provider to an authenticated tenant and caller scope."
---

Scope a [memory provider](../memory) by verified tenant and caller. eve locks the resulting key for provider reads, writes, and tools. The example uses `fileMemory()`, but the same resolver works with another provider.

## Derive scope from authenticated context

Never accept the tenant or user ID from the model. Resolve both from verified
session authentication and return a tuple:

```ts title="agent/memory/profile.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { fileMemory } from "eve/memory/file";

export default defineMemory({
  description: "Remember durable facts for the authenticated tenant user.",
  provider: fileMemory(),

  scope(ctx) {
    const caller = ctx.session.auth.current;
    const tenantId = caller?.attributes.tenantId;
    const principal = byPrincipal(ctx);

    if (caller?.principalType !== "user" || typeof tenantId !== "string" || principal === null) {
      return null;
    }

    return [tenantId, principal];
  },
  visibility: "scope",
});
```

Returning `null` disables memory for unauthenticated or incorrectly scoped
traffic. eve does not call the provider and never substitutes a shared scope.
`byPrincipal(ctx)` includes the authenticated principal type, authenticator,
issuer, and principal ID, so the tuple separates callers even if the same
principal ID exists in two authentication systems.

Use `auth.current` for the caller of the active turn. If a conversation is
permanently owned by its creator, use `auth.initiator` and enforce that
ownership at the channel boundary.

## Understand the locked provider boundary

eve validates the namespace and scope tuple, then derives an opaque
`memory.scope.key`. `fileMemory()` uses that key for its document. A hosted or
custom provider receives the same key in every recall, capture, and tools call.

Provider tools cannot change the locked scope. Preserve that boundary by using `memory.scope.key` in every downstream read and write.

For semantic retrieval, include the locked scope in the database or service
query itself, not as a filter after a global search. For custom capture, use
the provider's stable `operationId` as an idempotency key. See
[Build a memory provider](../memory/custom-provider) for the full contract.

## Choose recall visibility

The default `visibility: "scope"` hides recalled records from an earlier scope
when the authenticated caller changes within one session. Keep that default for
tenant-and-caller memory, as the definition above does. Set
`visibility: "session"` only when all callers who can share the session form
one trusted audience. Namespace remains an isolation boundary in either mode.

## Set the trust policy

Recalled values become user-role messages. Tell the agent that memories are
untrusted facts, not instructions, and what it may save; see
[Tell the model how to use memory](../memory#tell-the-model-how-to-use-memory)
for an instructions snippet. A custom provider can also set `approval` on its
tools when product policy calls for explicit confirmation before saving or
deleting memory.

`defineState` belongs to one session; use memory for cross-session data.
