---
"eve": patch
---

`toolCallState(conversation, part, { streaming })` from `eve/client`, `eve/react`, `eve/vue`, and `eve/svelte` tells a UI whether a tool call is running, awaiting input, completed, failed, rejected, cancelled, or interrupted. It reads the same session projection eve folds for its own channel activity, so a UI and eve's channels agree on every call, including task calls that outlive their turn, approved calls that run in a later turn, and a subagent's approval passed up through its task. `signInState(conversation, part)` says where a sign-in part's attempt stands, `ConversationInput` gains `callId` and `resumeTurnId`, and tool parts keep the tool's `label.start` and `label.complete` copy in `toolMetadata.eve.label` and a failed call's error code in `toolMetadata.eve.errorCode`.
