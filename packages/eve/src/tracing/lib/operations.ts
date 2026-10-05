import type { LiveOperation } from "./core/scopes.js";
import type {
  StepOptions,
  TraceLink,
  ScopeData,
  ScopeTerminal,
  ModelOptions,
  ActionOptions,
  ModelResult,
  CaptureDecision,
  Attributes,
  TraceReference,
  TraceErrorHandler,
} from "./core/types.js";

type Completion = ScopeTerminal & { errorType?: string; result?: ModelResult };
export interface Operation {
  readonly type: ScopeData["type"];
  readonly reference: TraceReference;
  readonly parent?: TraceReference;
  readonly startTimeMs: number;
  readonly finished: boolean;
  readonly capture: CaptureDecision;
  run<T>(execute: () => T, ceiling?: CaptureDecision): T;
  attributes(attributes: Attributes): void;
  complete(result?: Completion): Promise<void>;
  fail(error: unknown): Promise<void>;
}
export interface WrappedOperation<I, H extends Operation> {
  (input: I): Promise<H>;
  <T>(
    input: I & { describe?: (value: T) => Completion },
    execute: (operation: H) => T | PromiseLike<T>,
  ): Promise<T>;
}
type MemoryInput = Extract<ScopeData, { type: "memory" }>["options"];
export interface AttemptInput {
  readonly stepIndex: number;
  readonly attempt: number;
  readonly runtimeContext?: StepOptions["runtimeContext"];
  readonly channel?: StepOptions["channel"];
  readonly links?: readonly TraceLink[];
}
export interface TurnOperation extends Operation {
  attempt: WrappedOperation<AttemptInput, AttemptOperation>;
  /** Replaces the turn's links before its deferred span is exported. */
  links(links: readonly TraceLink[]): void;
  memory: WrappedOperation<MemoryInput, MemoryOperation>;
}
export interface AttemptOperation extends Operation {
  action: WrappedOperation<ActionOptions, ActionOperation>;
  callSubAgent: WrappedOperation<{ callId: string; agentName: string }, ActionOperation>;
  callRemoteAgent: WrappedOperation<{ callId: string; agentName: string }, ActionOperation>;
  tool<T>(input: ActionOptions, execute: () => T | PromiseLike<T>): Promise<T>;
  /**
   * Starts a tool execution whose action has not started yet. It moves under
   * the action with the same `callId` when that starts; otherwise it stays
   * under this attempt.
   */
  toolCall(input: Omit<ActionOptions, "kind">): Promise<ToolOperation>;
  modelCall(input: ModelOptions, key?: string): Promise<ModelOperation>;
  modelCall<T>(
    input: ModelOptions,
    execute: () => ModelCallReturn<T> | PromiseLike<ModelCallReturn<T>>,
  ): Promise<T>;
  modelStream<T>(
    input: ModelOptions,
    execute: () => ModelStreamReturn<T> | PromiseLike<ModelStreamReturn<T>>,
  ): Promise<T>;
  memory: WrappedOperation<MemoryInput, MemoryOperation>;
}
export interface ActionOperation extends Operation {
  approval: WrappedOperation<{ requestId: string; request?: unknown }, ApprovalOperation>;
  toolExecution(input?: { describe?: never }): Promise<ToolOperation>;
  toolExecution<T>(
    input: { describe?: (value: T) => Completion },
    execute: (operation: ToolOperation) => T | PromiseLike<T>,
  ): Promise<T>;
  memory: WrappedOperation<MemoryInput, MemoryOperation>;
}
export type ModelOperation = Operation;
export type ToolOperation = Operation;
export type ApprovalOperation = Operation;
export type MemoryOperation = Operation;
export interface ModelCallReturn<T> extends ModelResult {
  readonly result: T;
}
export interface ModelStreamReturn<T> {
  readonly result: T;
  readonly completion: PromiseLike<ModelResult>;
}

function report(
  onError: TraceErrorHandler | undefined,
  error: unknown,
  phase: "start" | "complete",
) {
  try {
    onError?.(error, { phase });
  } catch {}
}
export function wrappedOperation<I, H extends Operation>(
  start: (input: I) => Promise<H>,
  fallback: Completion = { outcome: "completed" },
  onError?: TraceErrorHandler,
): WrappedOperation<I, H> {
  function invoke(input: I): Promise<H>;
  function invoke<T>(
    input: I & { describe?: (value: T) => Completion },
    execute: (operation: H) => T | PromiseLike<T>,
  ): Promise<T>;
  async function invoke<T>(
    input: I,
    execute?: (operation: H) => T | PromiseLike<T>,
  ): Promise<H | T> {
    if (execute === undefined) return start(input);
    const handle = await start(input);
    let completion = fallback;
    try {
      const value = await handle.run(() => execute(handle));
      try {
        completion =
          (input as I & { describe?: (value: T) => Completion }).describe?.(value) ?? fallback;
      } catch (error) {
        report(onError, error, "complete");
      }
      return value;
    } catch (error) {
      completion = {
        outcome: "failed",
        errorType: error instanceof Error ? error.name : "_OTHER",
        error,
      };
      throw error;
    } finally {
      try {
        await handle.complete(completion);
      } catch (error) {
        report(onError, error, "complete");
      }
    }
  }
  return invoke;
}

export function operationHandle(
  runtime: LiveOperation,
  data: ScopeData,
  onError?: TraceErrorHandler,
): TurnOperation | AttemptOperation | ActionOperation | Operation {
  const live = <T extends Operation>(handle: T): T =>
    Object.defineProperties(handle, {
      finished: { get: () => runtime.finished },
      capture: { get: () => runtime.capture },
      parent: { get: () => runtime.parent },
    });
  const common: Operation = {
    type: runtime.type,
    reference: runtime.reference,
    startTimeMs: runtime.startTimeMs,
    get parent() {
      return runtime.parent;
    },
    get finished() {
      return runtime.finished;
    },
    get capture() {
      return runtime.capture;
    },
    run: (execute, ceiling) => runtime.run(execute, ceiling),
    attributes: (attributes) => runtime.attributes(attributes),
    complete: (result) => runtime.complete(result),
    fail: (error) => runtime.fail(error),
  };
  const child = async (data: ScopeData, key?: string, links?: readonly TraceLink[]) =>
    operationHandle(await runtime.child(data, key, { links }), data, onError);
  const memory = wrappedOperation(
    async (options: MemoryInput) => child({ type: "memory", options }),
    undefined,
    onError,
  );
  if (data.type === "activation")
    return live({
      ...common,
      memory,
      links: (links: readonly TraceLink[]) => runtime.update({ links }),
      attempt: wrappedOperation(
        async (input: AttemptInput) =>
          child(
            {
              type: "step",
              options: {
                index: input.stepIndex,
                attempt: input.attempt,
                runtimeContext: input.runtimeContext,
                channel: input.channel,
              },
            },
            undefined,
            input.links,
          ) as Promise<AttemptOperation>,
        undefined,
        onError,
      ),
    });
  if (data.type === "step") {
    const action = wrappedOperation(
      async (options: ActionOptions) =>
        child({ type: "action", options }) as Promise<ActionOperation>,
      undefined,
      onError,
    );
    const delegation = (kind: string) =>
      wrappedOperation(
        async (input: { callId: string; agentName: string }) =>
          child({
            type: "action",
            options: { callId: input.callId, name: input.agentName, kind },
          }) as Promise<ActionOperation>,
        undefined,
        onError,
      );
    const startModel = (options: ModelOptions, key?: string) =>
      child({ type: "model", options }, key);
    function modelCall(input: ModelOptions, key?: string): Promise<ModelOperation>;
    function modelCall<T>(
      input: ModelOptions,
      execute: () => ModelCallReturn<T> | PromiseLike<ModelCallReturn<T>>,
    ): Promise<T>;
    async function modelCall<T>(
      input: ModelOptions,
      execute?: string | (() => ModelCallReturn<T> | PromiseLike<ModelCallReturn<T>>),
    ): Promise<ModelOperation | T> {
      if (typeof execute !== "function") return startModel(input, execute);
      const handle = await startModel(input);
      let result: ModelCallReturn<T>;
      try {
        result = await handle.run(execute);
      } catch (error) {
        try {
          await handle.fail(error);
        } catch (tracingError) {
          report(onError, tracingError, "complete");
        }
        throw error;
      }
      try {
        await handle.complete({ outcome: "completed", result });
      } catch (error) {
        report(onError, error, "complete");
      }
      return result.result;
    }
    return live({
      ...common,
      memory,
      action,
      callSubAgent: delegation("subagent-call"),
      callRemoteAgent: delegation("remote-agent-call"),
      tool: (input, execute) => action(input, (handle) => handle.toolExecution({}, execute)),
      toolCall: (input) =>
        child({
          type: "tool",
          options: { callId: input.callId, name: input.name, arguments: input.arguments },
        }),
      modelCall,
      async modelStream(input, execute) {
        const handle = await startModel(input);
        try {
          const value = await handle.run(execute);
          const completion = Promise.resolve(value.completion)
            .then(
              (result) => handle.complete({ outcome: "completed", result }),
              (error) => handle.fail(error),
            )
            .catch((error) => report(onError, error, "complete"));
          runtime.waitUntil(completion);
          return value.result;
        } catch (error) {
          try {
            await handle.fail(error);
          } catch (tracingError) {
            report(onError, tracingError, "complete");
          }
          throw error;
        }
      },
    } as AttemptOperation);
  }
  if (data.type === "action")
    return live({
      ...common,
      memory,
      approval: wrappedOperation(
        async (input: { requestId: string; request?: unknown }) =>
          child({
            type: "approval",
            options: { ...input, callId: data.options.callId, actionName: data.options.name },
          }),
        { outcome: "ignored" },
        onError,
      ),
      toolExecution: wrappedOperation(
        async () =>
          child({
            type: "tool",
            options: {
              callId: data.options.callId,
              name: data.options.name,
              arguments: data.options.arguments,
            },
          }),
        undefined,
        onError,
      ),
    } as ActionOperation);
  return common;
}
