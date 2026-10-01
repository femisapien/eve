---
"eve": patch
---

Stream version 27 defines the lifecycle facts readers used to infer: an `action.result` status `cancelled` for calls eve stops, `authorization.required.callIds` for the calls a sign-in stopped, `input.requested.callId` for the call a relayed request serves, `processedDeliveryIds` on `session.waiting` and `turn.waiting`, and `meta.answerDeliveryIds`. A policy's automatic denial now reports `rejected`, like a person's. eve clients read stream version 27.
