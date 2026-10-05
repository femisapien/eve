# Agent tracing

`@vercel/agent-tracing` records agent execution with OpenTelemetry. It owns
span topology, capture, completion, and durable snapshots. The source package
is private; it is not yet published to npm. Its only runtime package dependency
is `@opentelemetry/api`.

## Setup

Supply your application's tracer provider. The library does not register global
telemetry or install another model SDK tracing pipeline.

```ts
import { createAgentTracing } from "@vercel/agent-tracing";

const tracing = createAgentTracing({ agentName: "support", provider });
```

Your provider owns exporters, sampling, and context propagation. Install its
context manager before concurrent work. `forceFlush()` and `shutdown()` call the
provider's lifecycle methods. A shared registration object can instead supply
`provider`, `idGenerator`, `samplesTrace`, `forceFlush`, and `shutdown`.

## Wrapped execution

Wrapped methods preserve the callback's value or error and complete their span.

```ts
await tracing.turn({ identity, sequence: 0 }, (turn) =>
  turn.attempt({ stepIndex: 0, attempt: 0 }, (attempt) =>
    attempt.tool({ callId: "lookup", name: "lookup" }, lookup),
  ),
);
```

`identity` contains `conversationId`, `runId`, and `turnId`. A turn can supply
framework metadata, attributes, and a capture decision. Capture defaults to
metadata only. Child operations cannot increase capture.

Attempts provide `action`, `callSubAgent`, and `callRemoteAgent`. Actions provide
`approval` and `toolExecution`. Turns, attempts, and actions provide `memory`.
Use `describe(value)` to map a callback result to an outcome or captured output.

## Handles

Omit the callback when execution starts and ends in different hooks.

```ts
const turn = await tracing.turn({ identity, sequence: 0 });
const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
const action = await attempt.action({ callId: "lookup", name: "lookup" });
const tool = await action.toolExecution();
try {
  const value = await tool.run(lookup);
  await tool.complete({ outcome: "completed", output: value });
} catch (error) {
  await tool.fail(error);
}
await action.complete();
await attempt.complete();
await turn.complete();
```

Handles expose execution, attributes, completion, and identity—not snapshots or
replay. Parent completion closes unfinished children. `complete()` is idempotent.

## Model calls and streams

`modelCall(data, execute)` accepts an envelope with `result`, `finishReason`,
`usage`, and optional response/content metadata. It returns only `result`.
Without a callback, `modelCall(data)` returns a model handle.

```ts
const stream = await attempt.modelStream({ provider: "test", modelId: "model" }, () => ({
  result: response.stream,
  completion: response.completion,
}));
```

The completion promise supplies finish reason, usage, and optional content. It
must settle on success, failure, or cancellation. The library returns the stream
unchanged and never consumes it. Parent completion waits for that promise.
`modelUsage` and `modelContent` translate AI SDK telemetry payloads; they do not
wire SDK hooks automatically.

## Delegation

Local delegation carries lineage across asynchronous calls. Remote calls need
an explicit sender transport and authenticated receiver trust check.

```ts
import { createAgentDelegationTransport } from "@vercel/agent-tracing/delegation";
const transport = createAgentDelegationTransport();
const fetchAgent = transport.transport(approvedAgentFetch);
await attempt.callRemoteAgent({ callId: "remote", agentName: "research" }, () =>
  fetchAgent(approvedAgentUrl),
);

transport.receive(request.headers, verifyAuthenticatedCaller, () =>
  tracing.turn({ identity, sequence: 0 }, runAgent),
);
```

Bind the sender only to approved destinations. It rejects redirects. The receiver
validates the bounded `x-agent-tracing` header before calling your trust callback.
Metadata is not authorization: verify authenticated provenance and the expected
caller, parent run, and call. Rejected metadata does not change application work.

## Durable runtimes

`@vercel/agent-tracing/runtime` exposes the recorder for framework adapters such
as eve. The host stores opaque `TraceSnapshot` JSON in its existing transaction.
`snapshot()`, `resume()`, and `checkpoint()` retain identity, outcomes, usage,
links, and unfinished children. `pendingTool()` and `resumeTool()` use the same
handle lifecycle when a tool's action parent arrives later.

These APIs are not present on `createAgentTracing()` or its handles. Durable
hosts select live attempts and deferred turns/actions without a public mode flag.
Request/MCP transport and authentication remain host responsibilities.

## Privacy and failures

Declined content does not enter snapshots. Failure classes survive redaction;
exception content does not. Serialized content is capped at 32 KiB, snapshots at
64 KiB, and unfinished children at 10,000. `onError(error, context)` is the only
tracing error channel. Trace output retains schema version 4.

Local tests cover output and recovery. They do not prove live Agent Runs ingestion.
