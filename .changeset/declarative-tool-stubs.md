---
"eve": patch
---

Add explicitly authorized, session-scoped JSON tool stubs for evals, with partial argument matching and durable response sequences shared by local subagents. Stub failures fail the eval even when the agent recovers; unmatched calls keep using the real tool.

Correct shared JSON Schema validation for decimal multiples, default containment bounds, own-property requirements, object/array equality, and dependency-map names.
