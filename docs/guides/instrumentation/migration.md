---
title: "Migrate Instrumentation"
description: "Move a single instrumentation.ts configuration into lifecycle instrumentation and OpenTelemetry destinations."
url: "/observability/instrumentation-migration"
---

Move `agent/instrumentation.ts` into path-named files under `agent/instrumentation/` and remove `experimental.instrumentationProviders` from `agent.ts`.

## Preserve metadata-only capture

In the removed API, omitted `recordInputs` and `recordOutputs` settings both
defaulted to `false`. Once an OpenTelemetry destination is present, the new
default includes content during development and for public conversations.

Add `agent/instrumentation/otel.ts` with an explicit metadata-only policy
before moving exporters:

```ts title="agent/instrumentation/otel.ts"
import { otel } from "eve/instrumentation/otel";

export default otel({
  functionId: "support-agent",
  traceChannelRequests: true,
  tracePolicy: () => ({
    emit: true,
    recordInputs: false,
    recordOutputs: false,
  }),
});
```

After verifying each destination's retention and access controls, widen
`recordInputs` or `recordOutputs` deliberately if needed.

## Move an OpenTelemetry exporter

Move each exporter into its own destination file and replace startup
`registerOTel(...)` calls with `otelIntegration(...)`. Install `@vercel/otel`
if the exporter comes from that package:

```bash
pnpm add @vercel/otel
```

```ts title="agent/instrumentation/honeycomb.ts"
import { OTLPHttpProtoTraceExporter } from "@vercel/otel";
import { otelIntegration } from "eve/instrumentation/otel";

export default otelIntegration({
  exportPolicy: {
    span: () => ({ redact: true, inputs: true, outputs: true }),
  },
  traceExporter: new OTLPHttpProtoTraceExporter({
    url: "https://api.honeycomb.io/v1/traces",
    headers: {
      "x-honeycomb-team": process.env.HONEYCOMB_API_KEY!,
    },
  }),
});
```

This destination policy keeps export metadata-only if the shared policy changes later. Add a file for each additional destination.

## Move runtime context and lifecycle events

Use this mapping when splitting the old definition:

| `agent/instrumentation.ts` field | New location                                 |
| -------------------------------- | -------------------------------------------- |
| `setup` with `registerOTel`      | One `otelIntegration()` file per destination |
| `functionId`                     | `otel({ functionId })`                       |
| `recordInputs`, `recordOutputs`  | `otel({ tracePolicy })`                      |
| `traceChannelRequests`           | `otel({ traceChannelRequests })`             |
| `events["step.started"]`         | `otelIntegration({ runtimeContext })`        |

Move `events["step.started"]` to the destination that needs those attributes;
see [Add runtime context](/docs/observability/otel#add-runtime-context). For
eve lifecycle events, create a separate file with `defineInstrumentation(...)`;
see
[Instrumentation](/docs/observability/instrumentation).

## Verify the migration

Run `eve build`; a leftover `agent/instrumentation.ts` causes a build error.

New eve deployments automatically sample 100% of requests. Existing Vercel
deployments need project sampling configured before you verify them. See
[Enable tracing on Vercel](/docs/observability/agent-runs#enable-tracing-on-vercel).

Then run the agent and verify each destination independently.
