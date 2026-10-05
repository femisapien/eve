import { trace, type TracerProvider } from "@opentelemetry/api";
import { randomUUID } from "node:crypto";
import type { AgentSpanIdGenerator } from "./adapters/otel-ids.js";
import { durableOtelBackend } from "./adapters/otel.js";
import { aiSdkContentSerializer } from "./adapters/serialization.js";
import { createTraceRecorder } from "./core/scopes.js";
import { currentAgentHandoff } from "./core/delegation.js";
import { intersectCapture } from "./core/activation.js";
import { operationHandle, wrappedOperation, type TurnOperation } from "./operations.js";
import type {
  RunIdentity,
  FrameworkIdentity,
  CaptureDecision,
  Attributes,
  TraceErrorHandler,
} from "./core/types.js";

export interface AgentTracingRegistration {
  readonly provider: TracerProvider;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly samplesTrace: (
    traceId: string,
    operation: { name: string; attributes: Attributes },
  ) => boolean;
  readonly forceFlush: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
}
export interface AgentTracing {
  turn: import("./operations.js").WrappedOperation<
    {
      identity: RunIdentity;
      sequence: number;
      framework?: FrameworkIdentity;
      capture?: CaptureDecision;
      attributes?: Attributes;
    },
    TurnOperation
  >;
  memory: AgentMemoryTracing;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}
interface MemoryInput<T> {
  identity: RunIdentity;
  storeId: string;
  slot: string;
  phase: string;
  capture?: CaptureDecision;
  describe?: (value: T) => {
    recordCount?: number;
    records?: readonly { id?: string; content: string }[];
  };
}
export interface AgentMemoryTracing {
  search<T>(data: MemoryInput<T>, execute: () => T | PromiseLike<T>): Promise<T>;
  write<T>(data: MemoryInput<T>, execute: () => T | PromiseLike<T>): Promise<T>;
}
export function createAgentTracing(input: {
  agentName: string;
  provider?: TracerProvider;
  registration?: AgentTracingRegistration;
  onError?: TraceErrorHandler;
}): AgentTracing {
  const provider = input.registration?.provider ?? input.provider ?? trace.getTracerProvider();
  const tracer = provider.getTracer("agent.tracing");
  const output = durableOtelBackend({
    tracer,
    idGenerator: input.registration?.idGenerator,
    samplesTrace: input.registration?.samplesTrace ?? (() => true),
  });
  const recorder = createTraceRecorder({
    output,
    serializer: aiSdkContentSerializer,
    onError: input.onError,
  });
  async function lifecycle(method: "forceFlush" | "shutdown") {
    try {
      const callback = (
        provider as TracerProvider & { forceFlush?(): Promise<void>; shutdown?(): Promise<void> }
      )[method];
      if (callback === undefined)
        throw new Error(`The tracer provider does not support ${method}.`);
      await callback.call(provider);
    } catch (error) {
      try {
        input.onError?.(error, { phase: "complete" });
      } catch {}
    }
  }
  const turn = wrappedOperation(
    async (data: {
      identity: RunIdentity;
      sequence: number;
      framework?: FrameworkIdentity;
      capture?: CaptureDecision;
      attributes?: Attributes;
    }) => {
      const handoff = currentAgentHandoff();
      const metadata = {
        sequence: data.sequence,
        attributes: data.attributes,
        subagent: handoff !== undefined,
        subagentName: handoff?.agentName,
        parentRunId: handoff?.parentRunId,
        parentCallId: handoff?.parentCallId,
      };
      const runtime = await recorder.activation({
        identity: {
          ...data.identity,
          conversationId: handoff?.conversationId ?? data.identity.conversationId,
          agentName: input.agentName,
          framework: data.framework,
        },
        operationId: randomUUID(),
        capture: intersectCapture(
          data.capture ?? { emit: true, recordInputs: false, recordOutputs: false },
          handoff?.capture,
        ),
        metadata,
        links:
          handoff !== undefined && data.sequence === 0
            ? [{ relationship: "agent.dispatch", context: handoff.caller }]
            : undefined,
      });
      return operationHandle(
        runtime,
        { type: "activation", options: metadata },
        input.onError,
      ) as TurnOperation;
    },
    undefined,
    input.onError,
  );
  return {
    turn,
    memory: recorder.memory,
    forceFlush: input.registration?.forceFlush ?? (() => lifecycle("forceFlush")),
    shutdown: input.registration?.shutdown ?? (() => lifecycle("shutdown")),
  };
}
