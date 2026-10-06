---
title: "Context Control"
description: "Choose what an eve agent's model sees and when, across instructions, skills, tools, the workspace, and subagents."
---

Put information where the model needs it: standing rules in instructions, optional procedures in skills, reference files in the sandbox, and specialist work in subagents. The table shows when each surface reaches the model.

## Recommended context layout

| Need                                                 | Use                                                    | What the model sees                                                              |
| ---------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Permanent identity, rules, or constraints            | System-role [instructions](../instructions)            | System context on every model call                                               |
| Durable application or retrieved context             | User-role [instructions](../instructions)              | A message added to conversation history at its lifecycle boundary                |
| A procedure needed only for some tasks               | A [skill](../skills)                                   | Its description until the model loads the full skill                             |
| A typed action or external operation                 | A [tool](../tools) or [connection](../connections)     | The callable schema and the result of each call                                  |
| Files or command execution                           | The [sandbox workspace](../sandbox)                    | A workspace hint, then files and command output the model requests through tools |
| A specialist with a separate prompt and capabilities | A [subagent](../subagents)                             | The child's reply as the tool result                                             |
| Instructions or capabilities that vary by caller     | A [dynamic capability](../guides/dynamic-capabilities) | The values resolved for the active session                                       |
| Scoped context retrieved from cross-session storage  | [Memory](../memory)                                    | Attributed user-role messages recalled before the current delivery               |

## Compaction and clear

Before a model call, eve checks the projected history together with the effective system instructions and advertised tool schemas. The check runs after `step.started` resolves dynamic capabilities. When the provider reports input usage, eve adds estimates for new messages and growth in the instructions and tool catalog to that count; unchanged schemas are not counted again.

Compaction reserves space for those instructions and tools while reducing conversation history. It cannot shrink the instructions or tool catalog themselves, so keep them within the selected model's context window.

User-role instructions follow the normal history lifecycle. Compaction can summarize them, and clear removes them without rerunning their static definitions or dynamic resolvers. System-role instructions remain outside history and continue to apply after either operation.

Recalled memory also uses user-role messages, but eve keeps their attribution
separate. Compaction excludes them from the summary, preserves their canonical
records, and recalls again after the checkpoint. Clear removes those session
records without deleting the provider's external data.

## What to read next

- [Instructions](../instructions): author the always-on system prompt.
- [Skills](../skills): provide procedures that load on demand.
- [Sandbox](../sandbox): give the model files and command execution.
- [Subagents](../subagents): isolate specialist work.
- [Dynamic capabilities](../guides/dynamic-capabilities): vary context and capabilities by session.
- [Memory](../memory): retrieve scoped context from storage that outlives a session.
