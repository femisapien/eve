---
issue: TBD
status: proposed
last_updated: "2026-10-03"
---

# Agent tracing library

## Decision

Extract reusable tracing into the private source package `@vercel/agent-tracing`
under `tracing/lib/`. Its imports and tests must not depend on eve. Keep event
translation, authorization, workflow retention, and filesystem discovery in eve.
Keep local storage and viewer code in `tracing/local/`.

## Authoring interface

Register telemetry separately from agent execution:

```ts
const registration = registerOtel({ serviceName: "support", destination: "vercel" });
const tracing = createAgentTracing({ agentName: "support", registration });

await tracing.turn({ identity, sequence: 0 }, (turn) =>
  turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
    attempt.tool({ callId: "lookup", name: "lookup" }, lookup),
  ),
);
```

An application can supply its own tracer provider instead. Registration owns
SDK setup, exporter selection, sampling, flush, and shutdown. Multiple agents
share an explicit registration; configuration object identity is not an API.

Operations support wrapped execution and explicit handles. Wrapped execution
preserves the application result or error and completes automatically. Handles
provide `run`, `complete`, and `fail`. Parent completion closes abandoned
children and waits for pending model streams without consuming them.

Wrapped model calls return `{ result, finishReason, usage, content }`. Streaming
calls return `{ result, completion }`; completion settles on success, failure,
or cancellation. No separate AI SDK tracing pipeline is installed.

## Durable boundary

The runtime subpath provides `createDurableAgentTracing`. The library creates,
serializes, validates, and resumes operation snapshots. The host stores opaque
JSON through its existing checkpoint transactions. It does not construct scope
records or maintain a second terminal/usage lifecycle.

Snapshots retain identity, parent references, start times, capture, links,
usage, terminal state, and unfinished children. `runtime.checkpoint` records
usage and terminal events without exporting a deferred operation. Pending tool
handles retain bounded enrichment and results and can resume before their
action parent exists. The host owns lookup keys and workflow retention.

eve stores one trace record collection. An action and its retained workflow
anchor share one record. Session policy, channel provenance, and principal
translation remain eve responsibilities.

## Topology and output

```text
eve events and policy ──> typed runtime operations ──> library snapshots
                                       │                    │
                                       └────── resume ──────┘
                                                │
                                       operation-kind lifecycle
                                                │
                                           OTel output
                                                │
                                         eve output profile
```

Preserve turn → attempt → model/action → approval/tool parentage. Attempts emit
`agent.step`; each model operation represents a physical invocation. Preserve
existing names, GenAI attributes, terminal events, usage, error classes,
tracestate, and Vercel session attribution. The library owns schema version 4;
extraction changes ownership, not the ingestion schema.

The eve output profile translates vendor attributes and links. Principal,
schedule, title, and delivery metadata use generic attributes, not core types.
Registration, Gateway cost conversion, and remote transport are optional
adapters. Core operation kinds own parent rules, preparation, completion, and
redaction together.

## Privacy and failures

Capture can decrease but cannot increase. Unsampled operations retain no
content. Snapshots and transport metadata have explicit bounds. Remote metadata
is accepted only after the host validates provenance; it is not authorization.
Approved sender transports reject redirects.

Tracing failures cannot replace application results or errors. Context fallback
executes a callback at most once. Typed diagnostics preserve causes. Invalid
snapshots disable only the affected trace operation.

## Delivery and validation

Keep design, standalone library, and eve integration in separate draft PRs.
The library PR includes its own consumer tests and no eve migration. Each
implementation PR has one changeset.

Validate operation snapshots, replay IDs, privacy, streaming, topology, OTel
registration, and eve worker recovery. Run typecheck, unit and integration
tests, lint, invariants, and docs checks. Live Agent Runs ingestion and fixture
e2e remain CI/platform checks; local exporter tests do not prove ingestion.
