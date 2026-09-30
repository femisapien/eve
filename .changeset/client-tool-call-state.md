---
"eve": patch
---

`toolCallState()` from `eve/client`, `eve/react`, `eve/vue`, and `eve/svelte` tells a UI whether a tool call is running, awaiting input, done, failed, denied, cancelled, or interrupted, following eve's turn and task lifecycle. A call approved at the root now reads as running until the turn after its approval runs it, and each settled root approval records that turn as `resumeTurnId`. Tool parts also keep the tool's authored `label.start` and `label.complete` copy as `toolMetadata.eve.label`, and a failed call's error code as `toolMetadata.eve.errorCode`; `eve dev` uses them to label a subagent's own tool calls and hide refused task calls.
