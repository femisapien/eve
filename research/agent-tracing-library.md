---
issue: TBD
status: proposed
last_updated: "2026-10-05"
---

# Agent tracing

Provide a framework-neutral facade and a separate durable runtime entrypoint
over one consolidated operation lifecycle. Share OTel output, serialization,
and remote delegation. Keep SDK registration, request/MCP tracing, authenticated
trust decisions, and workflow storage in eve.

The [module README](../packages/eve/src/tracing/lib/README.md) defines ownership,
operation handles, opaque snapshots, capture, and replay behavior.

Keep the library and eve migration in separate PRs. Measure library source,
net production code, and net total diff in both PR descriptions. Preserve
schema version 4 and existing topology; live ingestion remains a platform check.
