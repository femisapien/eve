import { randomBytes } from "node:crypto";
import { createSpanWriter, type TraceOperation } from "./writer.js";
import { usageAttributes } from "./attributes.js";
import {
  completeScope,
  capturedScopeData as capturedData,
  prepareScope,
  parentKinds,
  applyAttributes,
} from "./span-kinds.js";
import { mcpLifecycle, type McpLifecycle } from "./mcp.js";
import { intersectCapture } from "./activation.js";
import { snapshotRecord, traceSnapshot, validSnapshot, boundedSerializer } from "./snapshot.js";
import { withAgentHandoff } from "./delegation.js";
import { withoutDeclinedContent } from "./content-policy.js";
import { runTraceContext } from "./context.js";
import type {
  AgentTelemetry,
  Attributes,
  CaptureDecision,
  ContentSerializer,
  ExecutionContext,
  Operation,
  ScopeData,
  ScopeIdentity,
  ScopeRecord,
  ScopeTerminal,
  TraceErrorHandler,
  TraceLink,
  TraceReference,
  Usage,
} from "./types.js";

const UNFINISHED_CHILDREN = 10000;
const NO_CAPTURE: CaptureDecision = { emit: false, recordInputs: false, recordOutputs: false };

interface Construction extends Partial<ScopeRecord> {
  readonly key: string;
  readonly deferred?: boolean;
  readonly executionContext?: ExecutionContext;
  /** Applies sampling to a host-supplied root reference. */
  readonly sample?: boolean;
}
export interface ChildOptions {
  readonly links?: readonly TraceLink[];
}
export interface LiveOperation extends Operation {
  child(data: ScopeData, key?: string, options?: ChildOptions): Promise<LiveOperation>;
  usage(usage: Usage, key?: string): Promise<void>;
  error(error?: unknown, type?: string): void;
  /** Replaces the host context for this operation and its descendants. */
  useContext(context: ExecutionContext): void;
  /** Moves a tool that started before its action under that action. */
  adopt(action: LiveOperation): Promise<void>;
  /** Completes this operation, or closes the open descendants of a finished one. */
  release(result: ScopeTerminal): Promise<void>;
  /** Finished, with no unfinished descendants. */
  readonly settled: boolean;
  readonly awaitingParent: boolean;
  readonly callId?: string;
  readonly mcp: McpLifecycle;
  record(): ScopeRecord;
}

/** Durable trees reserve stable IDs and defer spans whose lifetime can cross processes. */
const DEFERRED_WHEN_DURABLE: ReadonlySet<ScopeData["type"]> = new Set([
  "activation",
  "action",
  "approval",
]);
/** Durable work that a successful parent leaves open, such as an action awaiting approval. */
const OUTLIVES_PARENT: ReadonlySet<ScopeData["type"]> = new Set(["action", "approval"]);

function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** Children with a stable identity hydrate on re-entry; the rest are numbered. */
function semanticKey(data: ScopeData, parent: ScopeData["type"]): string | undefined {
  switch (data.type) {
    case "step":
      return `step:${segment(data.options.index)}:${segment(data.options.attempt ?? 0)}`;
    case "action":
      return `action:${segment(data.options.callId)}`;
    case "tool":
      return parent === "step" ? `tool:${segment(data.options.callId)}` : "tool";
    case "approval":
      return `approval:${segment(data.options.requestId)}`;
    default:
      return undefined;
  }
}

function terminalOf(result: ScopeTerminal & { errorType?: string; result?: unknown }) {
  const failed = result.failed || result.outcome === "failed";
  return {
    ...result,
    model: "result" in result ? result.result : result.model,
    failed,
    outcome: result.outcome ?? (failed ? "failed" : "completed"),
    errorCode: "errorType" in result ? result.errorType : result.errorCode,
  } as ScopeTerminal;
}

export function createScopes(input: {
  readonly telemetry: AgentTelemetry;
  readonly serializer: ContentSerializer;
  readonly durable: boolean;
  readonly onError?: TraceErrorHandler;
}) {
  const telemetry = input.telemetry;
  const serializer = boundedSerializer(input.serializer, input.onError);
  const engine = createSpanWriter({ telemetry, onError: input.onError });
  const report: TraceErrorHandler = (error, context) => {
    try {
      input.onError?.(error, context);
    } catch {}
  };

  function reserve(
    data: ScopeData,
    key: string,
    parent: TraceReference | undefined,
    prepared: ReturnType<typeof prepareScope>,
    capture: CaptureDecision,
  ): TraceReference | undefined {
    const ids = telemetry.ids;
    if (!input.durable || ids === undefined) return undefined;
    if (data.type === "activation") {
      const traceId = ids.traceId(key);
      return {
        traceId,
        spanId: ids.spanId(key),
        traceFlags: capture.emit && (telemetry.samples?.(traceId, prepared) ?? true) ? 1 : 0,
      };
    }
    return parent === undefined
      ? undefined
      : { ...parent, spanId: ids.spanId(key), isRemote: false };
  }

  async function construct(
    identity: ScopeIdentity,
    capture: CaptureDecision,
    data: ScopeData,
    parent: LiveOperation | undefined,
    attempt: ScopeRecord["attempt"],
    binding: Construction,
    onChange: () => Promise<void>,
  ): Promise<LiveOperation> {
    try {
      return await constructOperation(identity, capture, data, parent, attempt, binding, onChange);
    } catch (error) {
      report(error, { phase: "start", operation: data.type, reference: binding.reference });
      return constructOperation(
        identity,
        NO_CAPTURE,
        capturedData(data, NO_CAPTURE),
        parent,
        attempt,
        {
          ...binding,
          sample: false,
          reference: {
            traceId:
              binding.reference?.traceId ??
              parent?.reference.traceId ??
              binding.parent?.traceId ??
              randomBytes(16).toString("hex"),
            spanId: binding.reference?.spanId ?? randomBytes(8).toString("hex"),
            traceFlags: 0,
          },
        },
        onChange,
      );
    }
  }

  async function constructOperation(
    identity: ScopeIdentity,
    capture: CaptureDecision,
    data: ScopeData,
    parent: LiveOperation | undefined,
    attempt: ScopeRecord["attempt"],
    binding: Construction,
    onChange: () => Promise<void>,
  ): Promise<LiveOperation> {
    if (
      binding.terminal?.error !== null &&
      typeof binding.terminal?.error === "object" &&
      !(binding.terminal.error instanceof Error) &&
      "message" in binding.terminal.error &&
      typeof binding.terminal.error.message === "string"
    ) {
      const error = new Error(binding.terminal.error.message);
      error.name = binding.terminal.errorCode ?? "Error";
      binding = { ...binding, terminal: { ...binding.terminal, error } };
    }
    const key = binding.key;
    const startTimeMs = binding.startTimeMs ?? Date.now();
    // A restored record keeps its saved parent; an adopted tool's differs from its owner.
    let parentReference = binding.parent ?? parent?.reference;
    if (capture.emit) capture = intersectCapture(capture, telemetry.active()?.capture);
    let actualCapture = capture;
    let actualData = capturedData(data, actualCapture);
    let prepared = prepareScope(
      {
        identity,
        data: actualData,
        attempt,
        capture: actualCapture,
        key,
        parent: parentReference,
        startTimeMs,
        links: binding.links,
      },
      serializer,
    );
    prepared = { ...prepared, attributes: { ...prepared.attributes, ...binding.attributes } };
    actualData = snapshotRecord(
      {
        key,
        identity,
        data: actualData,
        capture: actualCapture,
        reference: binding.reference ?? {
          traceId: "0".repeat(32),
          spanId: "0".repeat(16),
          traceFlags: 0,
        },
        startTimeMs,
      },
      serializer,
    ).data;
    let awaitingParent = binding.pendingParent === true;
    const deferred =
      binding.deferred ??
      (awaitingParent || (input.durable && DEFERRED_WHEN_DURABLE.has(actualData.type)));
    let host = binding.executionContext;
    let reference =
      binding.reference ?? reserve(data, key, parentReference, prepared, actualCapture);
    if (binding.sample === true && reference !== undefined)
      reference = {
        ...reference,
        traceFlags:
          (reference.traceFlags & 1) !== 0 &&
          actualCapture.emit &&
          (telemetry.samples?.(reference.traceId, prepared) ?? true)
            ? 1
            : 0,
      };
    let operation: TraceOperation | undefined = deferred
      ? undefined
      : engine.start(prepared, actualCapture, host, reference);
    const retainedReference = reference ?? operation?.reference;
    if (retainedReference === undefined)
      throw new Error("A deferred trace scope requires a reserved reference.");
    const sampled = (retainedReference.traceFlags & 1) !== 0;
    actualCapture = {
      emit: actualCapture.emit && sampled,
      recordInputs: actualCapture.emit && sampled && actualCapture.recordInputs,
      recordOutputs: actualCapture.emit && sampled && actualCapture.recordOutputs,
    };
    actualData = capturedData(actualData, actualCapture);
    let finished = binding.finished ?? false;
    let terminalResult = binding.terminal;
    const children = new Map<string, LiveOperation>();
    const pending = new Set<Promise<void>>();
    let childSequence = binding.childSequence ?? 0;
    let totalUsage = binding.usage;
    const usageKeys = new Set(binding.usageKeys ?? []);
    const enrichment: Record<string, Attributes[string]> = {};
    const callId =
      actualData.type === "action" || actualData.type === "tool"
        ? actualData.options.callId
        : undefined;

    function changed(): void {
      void onChange();
    }

    async function child(
      childData: ScopeData,
      childKey: string,
      options: ChildOptions = {},
    ): Promise<LiveOperation> {
      const existing = children.get(childKey);
      if (input.durable && existing !== undefined && !existing.settled) return existing;
      if (finished) throw new Error("The operation is not permitted in this trace scope.");
      for (const [previousKey, previous] of children)
        if (previous.settled) children.delete(previousKey);
      let childCapture = actualCapture;
      if (children.size >= UNFINISHED_CHILDREN) {
        report(new Error("Trace unfinished-child limit reached."), {
          phase: "start",
          operation: childData.type,
          reference: retainedReference,
        });
        childCapture = NO_CAPTURE;
      }
      if (childData.type === "model" && operation !== undefined)
        applyAttributes(operation, {
          "agent.model.id": childData.options.modelId,
          "agent.model.provider": childData.options.provider,
        });
      // Without stable IDs a tool cannot be re-parented, so it stays under the step.
      const awaiting =
        childData.type === "tool" && actualData.type === "step" && telemetry.ids !== undefined;
      const next = await construct(
        identity,
        childCapture,
        childData,
        runtime,
        childData.type === "step"
          ? { index: childData.options.index, attempt: childData.options.attempt ?? 0 }
          : attempt,
        {
          key: childKey,
          executionContext: host,
          links: options.links,
          pendingParent: awaiting || undefined,
          reference: awaiting
            ? {
                ...runtime.reference,
                spanId: telemetry.ids!.spanId(childKey),
                isRemote: false,
              }
            : undefined,
        },
        onChange,
      );
      if (childCapture.emit || children.size < UNFINISHED_CHILDREN) children.set(childKey, next);
      if (next.type === "action")
        for (const tool of children.values())
          if (tool.awaitingParent && tool.callId === next.callId) await tool.adopt(next);
      await onChange();
      return next;
    }

    async function closeChildren(result: ScopeTerminal, all: boolean): Promise<void> {
      for (const next of children.values())
        if (all || !OUTLIVES_PARENT.has(next.type))
          await next.release({ failed: result.failed, error: result.error, outcome: "abandoned" });
    }

    async function finish(result: ScopeTerminal): Promise<void> {
      if (pending.size > 0) await Promise.allSettled(pending);
      if (finished) return;
      if (terminalResult?.failed)
        result = {
          ...result,
          failed: true,
          error: terminalResult.error,
          errorCode: terminalResult.errorCode,
        };
      finished = true;
      terminalResult = result;
      await closeChildren(result, result.failed === true || !input.durable);
      operation ??= engine.start(prepared, actualCapture, host, retainedReference);
      const terminal =
        actualData.type === "activation" && result.usage === undefined
          ? { ...result, usage: totalUsage }
          : result;
      try {
        completeScope(operation, actualData, terminal, actualCapture, startTimeMs, serializer);
      } catch (error) {
        report(error, {
          phase: "complete",
          operation: actualData.type,
          reference: retainedReference,
        });
      }
      applyAttributes(operation, enrichment);
      if (actualData.type === "model" && result.model !== undefined)
        await parent?.usage(result.model.usage, key);
      operation.end(result.endTimeMs);
      await onChange();
    }

    const runtime: LiveOperation = {
      waitUntil(completion) {
        pending.add(completion);
        parent?.waitUntil(completion);
        void completion.then(
          () => pending.delete(completion),
          () => pending.delete(completion),
        );
      },
      snapshot: () => traceSnapshot(runtime.record()),
      attributes: (attributes) => runtime.update({ attributes }),
      modelCall: (options, key) => runtime.child({ type: "model", options }, key),
      fail(error) {
        runtime.error(error);
        return runtime.complete({ outcome: "failed", failed: true });
      },
      update(update) {
        if (finished) return;
        const attributes = (withoutDeclinedContent(update.attributes ?? {}, actualCapture) ??
          update.attributes) as Attributes;
        if (actualData.type === "activation")
          actualData = {
            ...actualData,
            options: {
              ...actualData.options,
              attributes: { ...actualData.options.attributes, ...attributes },
            },
          };
        prepared = {
          ...prepared,
          attributes: { ...prepared.attributes, ...attributes },
          links: update.links ?? prepared.links,
        };
        if (operation !== undefined) applyAttributes(operation, attributes);
        changed();
      },
      useContext(context) {
        host = context;
        for (const next of children.values()) next.useContext(context);
      },
      async adopt(action) {
        if (!awaitingParent) return;
        awaitingParent = false;
        parentReference = action.reference;
        prepared = { ...prepared, parent: action.reference };
        if (terminalResult?.outcome !== undefined) await finish(terminalResult);
        else changed();
      },
      async release(result) {
        if (finished) {
          await closeChildren(result, result.failed === true || !input.durable);
          return;
        }
        awaitingParent = false;
        await finish(terminalOf(terminalResult?.outcome === undefined ? result : terminalResult));
      },
      record() {
        return snapshotRecord(
          {
            version: 1,
            finished,
            pendingParent: awaitingParent || undefined,
            terminal: terminalResult,
            usage: totalUsage,
            usageKeys: [...usageKeys],
            attributes: { ...prepared.attributes, ...enrichment },
            childSequence,
            children: [...children.values()]
              .filter((child) => !child.settled)
              .map((child) => child.record()),
            key,
            identity,
            data: actualData,
            capture: actualCapture,
            reference: retainedReference,
            parent: parentReference,
            startTimeMs,
            attempt,
            links: prepared.links,
          },
          serializer,
        );
      },
      get parent() {
        return parentReference;
      },
      startTimeMs,
      child(data, childKey, options) {
        if (!parentKinds(data).includes(actualData.type))
          throw new Error("The operation is not permitted in this trace scope.");
        const name =
          childKey === undefined
            ? ((input.durable ? semanticKey(data, actualData.type) : undefined) ??
              `${data.type}:${childSequence++}`)
            : `${data.type}:${segment(childKey)}`;
        return child(data, `${key}/${name}`, options);
      },
      type: actualData.type,
      reference: retainedReference,
      callId,
      get capture() {
        return actualCapture;
      },
      mcp: mcpLifecycle({
        serializer,
        ...actualCapture,
        write(attributes) {
          const permitted = (withoutDeclinedContent(attributes, actualCapture) ??
            attributes) as Attributes;
          Object.assign(enrichment, permitted);
          if (operation !== undefined) applyAttributes(operation, permitted);
        },
        error(error, type) {
          runtime.error(error, type);
        },
      }),
      get finished() {
        return finished;
      },
      get settled() {
        return finished && [...children.values()].every((next) => next.settled);
      },
      get awaitingParent() {
        return awaitingParent;
      },
      run(execute, ceiling) {
        if (finished) throw new Error("The trace scope has already finished.");
        actualCapture = intersectCapture(
          intersectCapture(actualCapture, ceiling),
          telemetry.active()?.capture,
        );
        actualData = capturedData(actualData, actualCapture);
        if (!actualCapture.recordOutputs && terminalResult !== undefined)
          terminalResult = { ...terminalResult, error: undefined };
        prepared = {
          ...prepared,
          attributes: (withoutDeclinedContent(prepared.attributes, actualCapture) ??
            prepared.attributes) as Attributes,
        };
        const permitted = withoutDeclinedContent(enrichment, actualCapture) ?? enrichment;
        for (const key of Object.keys(enrichment)) if (!(key in permitted)) delete enrichment[key];
        const callback =
          actualData.type === "action" &&
          (actualData.options.kind === "subagent-call" ||
            actualData.options.kind === "remote-agent-call")
            ? () =>
                withAgentHandoff(
                  {
                    caller: retainedReference,
                    conversationId: identity.conversationId,
                    parentRunId: identity.runId,
                    parentCallId: actualData.type === "action" ? actualData.options.callId : "",
                    agentName: actualData.type === "action" ? actualData.options.name : "",
                    capture: actualCapture,
                  },
                  execute,
                )
            : execute;
        return runTraceContext(telemetry, runtime, callback, host);
      },
      async complete(result = terminalResult ?? {}) {
        if (finished) return;
        if (awaitingParent) {
          // Held until the action it belongs to starts, or its step closes it.
          terminalResult = terminalOf(
            terminalResult?.failed
              ? {
                  ...result,
                  failed: true,
                  error: terminalResult.error,
                  errorCode: terminalResult.errorCode,
                }
              : result,
          );
          changed();
          return;
        }
        await finish(terminalOf(result));
      },
      async usage(usage, callKey) {
        if (callKey !== undefined && usageKeys.has(callKey)) return;
        if (callKey !== undefined) usageKeys.add(callKey);
        if (operation !== undefined) applyAttributes(operation, usageAttributes(usage));
        totalUsage = {
          inputTokens:
            usage.inputTokens === undefined
              ? totalUsage?.inputTokens
              : (totalUsage?.inputTokens ?? 0) + usage.inputTokens,
          outputTokens:
            usage.outputTokens === undefined
              ? totalUsage?.outputTokens
              : (totalUsage?.outputTokens ?? 0) + usage.outputTokens,
          costUsd:
            usage.costUsd === undefined
              ? totalUsage?.costUsd
              : (totalUsage?.costUsd ?? 0) + usage.costUsd,
        };
        await parent?.usage(usage, callKey);
      },
      error(error, errorType) {
        terminalResult = {
          ...terminalResult,
          failed: true,
          error: actualCapture.recordOutputs ? error : undefined,
          errorCode: errorType ?? (error instanceof Error ? error.name : undefined),
        };
        if (operation !== undefined) operation.fail(terminalResult.error, terminalResult.errorCode);
        changed();
      },
    };
    for (const saved of binding.children ?? [])
      children.set(
        saved.key,
        await construct(
          saved.identity,
          intersectCapture(saved.capture, actualCapture),
          saved.data,
          runtime,
          saved.attempt,
          { ...saved, deferred: true, executionContext: host },
          onChange,
        ),
      );
    if (!finished && operation !== undefined && actualData.type === "step")
      operation.addEvent("step.started", undefined, startTimeMs);
    return runtime;
  }

  return {
    /** Starts a turn tree. Durable turns reserve their IDs from `key`. */
    start(facts: {
      identity: ScopeIdentity;
      key: string;
      capture: CaptureDecision;
      data: ScopeData;
      parent?: TraceReference;
      reference?: TraceReference;
      startTimeMs?: number;
      links?: readonly TraceLink[];
      context?: ExecutionContext;
      onChange?: () => Promise<void>;
    }): Promise<LiveOperation> {
      return construct(
        facts.identity,
        facts.capture,
        facts.data,
        undefined,
        undefined,
        {
          key: facts.key,
          parent: facts.parent,
          reference: facts.reference,
          sample: facts.reference !== undefined && facts.data.type === "activation",
          startTimeMs: facts.startTimeMs,
          links: facts.links,
          executionContext: facts.context,
        },
        facts.onChange ?? (() => Promise.resolve()),
      );
    },
    /** Rebuilds a tree from a checkpoint, or returns `undefined` for an unusable one. */
    async restore(
      snapshot: unknown,
      options: {
        capture?: CaptureDecision;
        context?: ExecutionContext;
        onChange?: () => Promise<void>;
      } = {},
    ): Promise<LiveOperation | undefined> {
      if (!validSnapshot(snapshot)) {
        report(new Error("Invalid tracing checkpoint."), { phase: "restore" });
        return undefined;
      }
      return construct(
        snapshot.identity,
        intersectCapture(snapshot.capture, options.capture),
        snapshot.data,
        undefined,
        snapshot.attempt,
        { ...snapshot, deferred: true, executionContext: options.context },
        options.onChange ?? (() => Promise.resolve()),
      );
    },
  };
}
