---
"eve": patch
---

`toolCallState()` from `eve/client`, `eve/react`, `eve/vue`, and `eve/svelte` tells a UI whether a tool call is running, awaiting input, done, failed, denied, cancelled, or interrupted, following eve's turn and task lifecycle. A call approved at the root now reads as running until the turn after its approval runs it, and each settled root approval records that turn as `resumeTurnId`. `agentToolSession()`, `agentCallTurns()`, `conversationAuthorizations()`, and `followedAgentToolCallIds()` are exported for rendering followed agent sessions and sign-ins.
