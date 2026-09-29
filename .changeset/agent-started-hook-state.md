---
"eve": patch
---

`agent.started` hooks now keep the session state and sandbox changes they make, like hooks for every other stream event. When a child session opens while the parent's model step is running, eve still writes `agent.started` to the stream right away, then runs its hooks when that step ends. Before, those hooks ran during the step, and the changes they made were discarded.
