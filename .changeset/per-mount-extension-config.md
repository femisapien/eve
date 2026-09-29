---
"eve": patch
---

Extension configuration and durable state now belong to each logical mount, so duplicate mounts can use independent config and state. Old session handoffs are rejected rather than migrated; sessions with legacy extension state must finish on their original deployment or be restarted on the updated deployment.
