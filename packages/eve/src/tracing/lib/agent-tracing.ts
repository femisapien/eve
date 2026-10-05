import { randomUUID } from "node:crypto";
import { otelTelemetry } from "./adapters/otel.js";
import { aiSdkContentSerializer } from "./adapters/serialization.js";
import { createScopes, type LiveOperation } from "./core/scopes.js";
import { currentAgentHandoff } from "./core/delegation.js";
import { intersectCapture } from "./core/activation.js";
import { operationHandle, wrappedOperation, type TurnOperation } from "./operations.js";
import type {
  AgentTelemetry,
  Attributes,
  CaptureDecision,
  ContentSerializer,
  FrameworkIdentity,
  RunIdentity,
  TraceCheckpointer,
  TraceErrorHandler,
} from "./core/types.js";

export interface AgentTracingOptions {
  readonly agentName: string;
  /** Span output and context propagation. Defaults to the global OpenTelemetry provider. */
  readonly telemetry?: AgentTelemetry;
  /**
   * Makes turns durable. Each in-flight turn is saved under a library-chosen
   * key and removed when the turn completes. Calling `turn()` again with the
   * same identity, in this or a later process, continues the saved turn.
   */
  readonly checkpointer?: TraceCheckpointer;
  /** Defaults to the AI SDK content serializer. */
  readonly serializer?: ContentSerializer;
  readonly onError?: TraceErrorHandler;
}

export interface TurnInput {
  readonly identity: RunIdentity;
  readonly sequence: number;
  readonly framework?: FrameworkIdentity;
  readonly capture?: CaptureDecision;
  readonly attributes?: Attributes;
}

export interface AgentTracing {
  turn: import("./operations.js").WrappedOperation<TurnInput, TurnOperation>;
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

const METADATA_ONLY: CaptureDecision = { emit: true, recordInputs: false, recordOutputs: false };

export function createAgentTracing(input: AgentTracingOptions): AgentTracing {
  const telemetry = input.telemetry ?? otelTelemetry();
  const checkpointer = input.checkpointer;
  if (checkpointer !== undefined && telemetry.ids === undefined)
    throw new Error(
      "Durable agent tracing needs stable span IDs. Pass the AgentSpanIdGenerator installed on your tracer provider to otelTelemetry({ idGenerator }).",
    );
  const report: TraceErrorHandler = (error, context) => {
    try {
      input.onError?.(error, context);
    } catch {}
  };
  const scopes = createScopes({
    telemetry,
    serializer: input.serializer ?? aiSdkContentSerializer,
    durable: checkpointer !== undefined,
    onError: input.onError,
  });
  // Turns hydrated in this process, so concurrent hooks share one tree.
  const live = new Map<string, Promise<LiveOperation>>();

  function turnKey(identity: RunIdentity): string {
    if (checkpointer === undefined) return `turn:${randomUUID()}`;
    return ["turn", input.agentName, identity.runId, identity.turnId]
      .map(encodeURIComponent)
      .join(":");
  }

  /** Writes are serialized so a slow store never persists an older tree last. */
  function persistence(key: string, root: () => LiveOperation | undefined) {
    let queue = Promise.resolve();
    return () => {
      if (checkpointer === undefined) return queue;
      queue = queue.then(async () => {
        const operation = root();
        if (operation === undefined) return;
        try {
          if (operation.finished) await checkpointer.delete(key);
          else await checkpointer.set(key, operation.snapshot());
        } catch (error) {
          report(error, { phase: "checkpoint", operation: "activation" });
        }
      });
      return queue;
    };
  }

  async function openTurn(data: TurnInput): Promise<LiveOperation> {
    const handoff = currentAgentHandoff();
    const key = turnKey(data.identity);
    const capture = intersectCapture(data.capture ?? METADATA_ONLY, handoff?.capture);
    let root: LiveOperation | undefined;
    const onChange = persistence(key, () => root);
    const saved = checkpointer === undefined ? undefined : await loadCheckpoint(key);
    root =
      saved === undefined
        ? undefined
        : await scopes.restore(saved, { capture: data.capture, onChange });
    if (root === undefined) {
      const metadata = {
        sequence: data.sequence,
        attributes: data.attributes,
        subagent: handoff !== undefined,
        subagentName: handoff?.agentName,
        parentRunId: handoff?.parentRunId,
        parentCallId: handoff?.parentCallId,
      };
      root = await scopes.start({
        identity: {
          ...data.identity,
          conversationId: handoff?.conversationId ?? data.identity.conversationId,
          agentName: input.agentName,
          framework: data.framework,
        },
        key,
        capture,
        data: { type: "activation", options: metadata },
        links:
          handoff !== undefined && data.sequence === 0
            ? [{ relationship: "agent.dispatch", context: handoff.caller }]
            : undefined,
        onChange,
      });
    }
    await onChange();
    return root;
  }

  async function loadCheckpoint(key: string): Promise<unknown> {
    try {
      return await checkpointer!.get(key);
    } catch (error) {
      report(error, { phase: "restore", operation: "activation" });
      return undefined;
    }
  }

  async function turnOperation(data: TurnInput): Promise<TurnOperation> {
    const key = checkpointer === undefined ? undefined : turnKey(data.identity);
    for (const [cached, turn] of live) if ((await turn).finished) live.delete(cached);
    let opened = key === undefined ? undefined : live.get(key);
    if (opened === undefined) {
      opened = openTurn(data);
      if (key !== undefined) live.set(key, opened);
    }
    const operation = await opened;
    return operationHandle(
      operation,
      { type: "activation", options: { sequence: data.sequence } },
      input.onError,
    ) as TurnOperation;
  }

  async function lifecycle(callback: () => Promise<void>) {
    try {
      await callback();
    } catch (error) {
      report(error, { phase: "complete" });
    }
  }

  async function memory<T>(
    operation: "search_memory" | "upsert_memory",
    data: MemoryInput<T>,
    execute: () => T | PromiseLike<T>,
  ): Promise<T> {
    const active = telemetry.active();
    const handle = await scopes.start({
      identity: data.identity,
      key: `memory:${randomUUID()}`,
      capture: data.capture ?? active?.capture ?? METADATA_ONLY,
      parent: active?.reference,
      data: {
        type: "memory",
        options: { operation, phase: data.phase, slot: data.slot, storeId: data.storeId },
      },
    });
    let value: T;
    try {
      value = await handle.run(execute);
    } catch (error) {
      await handle.fail(error).catch((tracingError) => report(tracingError, { phase: "complete" }));
      throw error;
    }
    await handle
      .complete({ outcome: "completed", ...data.describe?.(value) })
      .catch((error) => report(error, { phase: "complete" }));
    return value;
  }

  return {
    turn: wrappedOperation(turnOperation, undefined, input.onError),
    memory: {
      search: (data, execute) => memory("search_memory", data, execute),
      write: (data, execute) => memory("upsert_memory", data, execute),
    },
    forceFlush: () => lifecycle(() => telemetry.forceFlush()),
    shutdown: () => lifecycle(() => telemetry.shutdown()),
  };
}
