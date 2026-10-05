export { createTraceRecorder } from "./core/scopes.js";
export {
  durableOtelBackend,
  liveOtelBackend,
  activeTraceOperation,
  withErrorContent,
} from "./adapters/otel.js";
export { AgentSpanIdGenerator } from "./adapters/otel-ids.js";
export { modelUsage, modelContent } from "./adapters/ai-sdk-payload.js";
export {
  aiSdkContentSerializer,
  truncateTelemetryText,
  boundedPrincipalId,
  contentAttribute,
  textContentAttribute,
  telemetryByteLength,
  CONTENT_ATTRIBUTE_LIMIT,
} from "./adapters/serialization.js";
export { snapshotReference } from "./core/snapshot.js";
export { currentCapture, withCapture } from "./capture.js";
export { withoutDeclinedContent, type ResolvedContentOptions } from "./core/content-policy.js";
export { mcpLifecycle, type McpLifecycle, type McpUpdate } from "./core/mcp.js";
export { invocationName } from "./core/span-kinds.js";
export { USAGE_FIELDS } from "./core/attributes.js";
export type {
  Attributes,
  TraceSnapshot,
  ExecutionContext,
  TraceReference,
  CaptureDecision,
  TraceLink,
  MappingContext,
  OutputMapping,
  Usage,
  ContentPart,
  Operation,
  OperationFacts,
  TurnMetadata,
} from "./core/types.js";
export type DurableTraceRuntime = ReturnType<typeof import("./core/scopes.js").createTraceRecorder>;
