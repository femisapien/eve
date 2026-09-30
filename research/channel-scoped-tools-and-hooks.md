---
issue: "None (long-standing request; follows the Slack renderer split in PR #4028)"
status: proposed
last_updated: "2026-09-30"
---

# Channel-scoped tools and hooks

## Summary

An agent with several channels gives every session the same tools and runs every hook for every session. Authors who want a tool only in Slack, or a side effect only for GitHub sessions, work around it today:

- **Tools** have no channel information at all. `ToolContext` carries no channel, so a Slack-only tool must become a `defineDynamic` resolver that returns `null` elsewhere. That takes on durable callback descriptors and closure-serialization rules just to hide a tool.
- **Hooks** see `ctx.channel.kind` and guard on it: `if (ctx.channel.kind !== "channel:slack") return`. The `channel:` prefix is an undocumented format, and a typo silently disables the hook.
- **Channel `events`** are documented as the place for channel-specific side effects. But on a built-in channel an authored handler replaces the default for that event, so adding a log line can drop eve's reply. The Slack channel now takes renderers (#4028), which makes a side effect there a "renderer" that must remember to call `next()`.

This plan adds one optional field, `channels`, to `defineTool` and `defineHook`. It lists the channels whose sessions receive the tool or run the hook:

```ts title="agent/tools/add_reaction.ts"
import { defineTool } from "eve/tools";
import { z } from "zod";
import slack from "../channels/slack";

export default defineTool({
  channels: [slack],
  description: "React to the message that started this turn with an emoji.",
  inputSchema: z.object({ emoji: z.string() }),
  async execute({ emoji }) {
    // …
  },
});
```

```ts title="agent/hooks/slack-audit.ts"
import { defineHook } from "eve/hooks";
import slack from "../channels/slack";

export default defineHook({
  channels: [slack],
  events: {
    async "turn.completed"(event, ctx) {
      await recordSlackTurn({ sessionId: ctx.session.id, turnId: event.turnId });
    },
  },
});
```

Without `channels`, both behave as they do today.

## Authoring API

```ts
interface ToolDefinitionBase {
  /** Channels whose sessions receive this tool. Omit for every session. */
  readonly channels?: readonly Channel[];
  // …
}

interface HookDefinition {
  /** Channels whose sessions run this hook. Omit for every session. */
  readonly channels?: readonly Channel[];
  readonly events: StreamEventHooks;
}
```

Entries are channel definitions imported from `agent/channels/`, not name strings. This is the same reference [`isChannel`](../docs/guides/instrumentation/otel.mdx) already uses:

- A typo or deleted channel fails at type-check and build, not silently at runtime.
- Renaming or moving a channel file keeps references correct.
- Names still come from file paths. The compiler records each tool's and hook's channel names (`["slack"]`) in the manifest, so runtime matching needs no module identity.

## Semantics

A session belongs to the channel that created it: the one `ctx.channel.kind` reports. That channel doesn't change for the life of the session; a cross-channel hand-off (`ctx.to(slack, target).send(...)`) starts a new session owned by the destination. So a session's tools are fixed from its first step, and prompt caching is unaffected.

| Session                                                                 | Matches `channels: [slack]`?            |
| ----------------------------------------------------------------------- | --------------------------------------- |
| Started or continued by `agent/channels/slack.ts`                       | Yes                                     |
| Started by another channel's `ctx.to(slack, target).send(...)`          | Yes, the new session is a Slack session |
| Started by a schedule's `to(slack, target).send(...)`                   | Yes                                     |
| A schedule's own run, without `to(...)`                                 | No                                      |
| A delegated subagent session, including one called from a Slack session | No                                      |

**Tools.** A scoped tool is left out of the model's tools in any other session, and a call to it there fails like a call to any tool the session doesn't have. The check joins `availableInSubagents` in the harness's one availability filter (`shouldHideTool`), which already applies to both the tools eve advertises and the tools it executes. Other paths that call tools, such as the `workflow` tool's generated programs, must use the same filter.

**Hooks.** A scoped hook runs only for events recorded on a matching session's stream. An event a child session relays to its parent, such as a nested question, is recorded on the parent's stream and counts as the parent's. The child's own events belong to the child's session, which never matches. `ctx.cancel()` and failure isolation are unchanged.

**Delegated sessions never match.** A subagent session's channel is its parent's call, not an authored channel, and it has no Slack thread or GitHub pull request to act on. A scoped tool is therefore never available in subagents, whatever `availableInSubagents` says. Inheriting the root session's channel would give children tools they can't use.

## Validation

The build fails, naming the tool or hook file, when:

- an entry is not a channel definition from this agent's `agent/channels/`, including a value left `undefined` by an import cycle;
- `channels` is empty, since a tool or hook that never applies should be deleted;
- a local subagent's own tool or hook sets `channels`. Local subagents don't declare channels, and their sessions are always delegated, so the field could never match.

## Scope

- **Static tools and hooks only.** `defineDynamic` tool resolvers already receive `ctx.channel` and can return `null`; `isChannel(ctx.channel, slack)` works there today. Adding `channels` to `defineDynamic` would be a second way to express the same thing.
- **App-authored definitions only.** Extension-contributed tools and hooks can't import an app's channels. Setting `channels` on them is a build error.
- **No typed channel context.** `ToolContext` still has no channel, and `HookContext.channel` keeps its `kind` and `continuationToken`. Narrowing either to a scoped channel's metadata type is a follow-up.
- **Connections, skills, subagents, and instructions** are out of scope. Their dynamic forms can already branch on `ctx.channel`.

## Compatibility

- Additive: every existing tool and hook omits `channels` and keeps its behavior.
- The `tool` and `hook` extension contracts move to their next epoch and retain the current one.
- Docs:
  - [Hooks](../docs/guides/hooks.md): "Scope side effects to a channel" teaches `channels` instead of channel `events` or `ctx.channel.kind` guards.
  - [Tools](../docs/tools): gains a short section.
  - [Slack](../docs/channels/slack.mdx): "Customize rendering" points side effects to scoped hooks.

## Follow-ups

- Revisit the top-level `events` on other built-in channels (GitHub, Linear, and others). Once side effects have a scoped home, those maps are only for delivery, and Slack's renderer model may fit them too.
- Typed `ctx.channel` for a tool or hook scoped to one channel.
