import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  AgentSpanIdGenerator,
  createAgentTracing,
  otelTelemetry,
  type TraceCheckpointer,
} from "@vercel/agent-tracing";

const identity = { conversationId: "conversation", runId: "run", turnId: "turn" };

function memoryCheckpointer() {
  const entries = new Map<string, string>();
  const checkpointer: TraceCheckpointer = {
    get: (key) => {
      const value = entries.get(key);
      return value === undefined ? undefined : JSON.parse(value);
    },
    set: (key, value) => void entries.set(key, JSON.stringify(value)),
    delete: (key) => void entries.delete(key),
  };
  return { checkpointer, entries };
}

function worker(checkpointer: TraceCheckpointer, exporter: InMemorySpanExporter) {
  const idGenerator = new AgentSpanIdGenerator();
  const provider = new BasicTracerProvider({
    idGenerator,
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return createAgentTracing({
    telemetry: otelTelemetry({ provider, idGenerator }),
    checkpointer,
  });
}

describe("durable agent tracing", () => {
  it("continues a turn in a new worker by calling the same operations again", async () => {
    const { checkpointer, entries } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();

    const first = worker(checkpointer, exporter);
    const turn = await first.turn({ agentName: "support", identity, sequence: 0 });
    const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
    await attempt.modelCall({ provider: "test", modelId: "model" }, () => ({
      result: "call lookup",
      finishReason: "tool-calls",
      usage: { inputTokens: 3, outputTokens: 2 },
    }));
    const action = await attempt.action({ callId: "lookup", name: "lookup" });
    await action.approval({ requestId: "approval" });
    expect(entries.size).toBe(1);

    // The first worker is lost while Alice reviews the approval.
    const second = worker(checkpointer, exporter);
    const resumedTurn = await second.turn({ agentName: "support", identity, sequence: 0 });
    const resumedAttempt = await resumedTurn.attempt({ stepIndex: 0, attempt: 0 });
    const resumedAction = await resumedAttempt.action({ callId: "lookup", name: "lookup" });
    const approval = await resumedAction.approval({ requestId: "approval" });
    expect(resumedTurn.reference).toEqual(turn.reference);
    expect(resumedAction.reference).toEqual(action.reference);

    await approval.complete({ outcome: "approved" });
    await resumedAction.toolExecution({}, () => "Alice's answer");
    await resumedAction.complete();
    await resumedAttempt.complete();
    await resumedTurn.complete();
    await second.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([
      "chat model",
      "agent.approval",
      "execute_tool lookup",
      "agent.action",
      "agent.step",
      "invoke_agent support",
    ]);
    const byName = new Map(spans.map((span) => [span.name, span]));
    const root = byName.get("invoke_agent support")!;
    expect(root.spanContext().spanId).toBe(turn.reference.spanId);
    expect(byName.get("agent.step")!.parentSpanContext?.spanId).toBe(turn.reference.spanId);
    expect(byName.get("agent.approval")!.attributes["agent.approval.outcome"]).toBe("approved");
    expect(root.attributes["gen_ai.usage.input_tokens"]).toBe(3);
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    expect(entries.size).toBe(0);
  });

  it("keeps an action open after its attempt and the turn complete", async () => {
    const { checkpointer, entries } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();
    const first = worker(checkpointer, exporter);
    const turn = await first.turn({ agentName: "support", identity, sequence: 0 });
    const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
    const action = await attempt.action({ callId: "lookup", name: "lookup" });
    await action.approval({ requestId: "approval" });
    await attempt.complete();
    await turn.complete();
    expect(entries.size).toBe(1);

    // Bob approves the request after the turn has parked.
    const second = worker(checkpointer, exporter);
    expect(await second.resume({ identity: { ...identity, turnId: "other" } })).toBeUndefined();
    const resumed = await second.resume({ identity });
    const resumedAttempt = await resumed!.attempt({ stepIndex: 0, attempt: 0 });
    const resumedAction = await resumedAttempt.action({ callId: "lookup", name: "lookup" });
    await (
      await resumedAction.approval({ requestId: "approval" })
    ).complete({
      outcome: "approved",
    });
    await resumedAction.complete();
    await second.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([
      "agent.step",
      "invoke_agent support",
      "agent.approval",
      "agent.action",
    ]);
    expect(spans[3]!.parentSpanContext?.spanId).toBe(attempt.reference.spanId);
    expect(entries.size).toBe(0);
  });

  it("moves a tool that starts before its action under that action", async () => {
    const { checkpointer } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();
    const tracing = worker(checkpointer, exporter);
    const turn = await tracing.turn({ agentName: "support", identity, sequence: 0 });
    const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
    const early = await attempt.toolCall({ callId: "lookup", name: "lookup" });
    await early.complete({ outcome: "completed" });
    const orphan = await attempt.toolCall({ callId: "final", name: "final" });
    await orphan.complete({ outcome: "completed" });
    const action = await attempt.action({ callId: "lookup", name: "lookup" });
    await action.complete();
    await attempt.complete();
    await turn.complete();
    await tracing.forceFlush();

    const byName = new Map(exporter.getFinishedSpans().map((span) => [span.name, span]));
    expect(byName.get("execute_tool lookup")!.parentSpanContext?.spanId).toBe(
      action.reference.spanId,
    );
    expect(byName.get("execute_tool final")!.parentSpanContext?.spanId).toBe(
      attempt.reference.spanId,
    );
  });

  it("adopts a reserved turn reference and applies sampling", async () => {
    const { checkpointer } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();
    const idGenerator = new AgentSpanIdGenerator();
    const tracing = createAgentTracing({
      telemetry: otelTelemetry({
        provider: new BasicTracerProvider({
          idGenerator,
          spanProcessors: [new SimpleSpanProcessor(exporter)],
        }),
        idGenerator,
        samplesTrace: (traceId) => traceId !== "b".repeat(32),
      }),
      checkpointer,
    });
    const reference = { traceId: "a".repeat(32), spanId: "c".repeat(16), traceFlags: 1 };
    const turn = await tracing.turn({ agentName: "support", identity, sequence: 0, reference });
    expect(turn.reference).toMatchObject(reference);
    const dropped = await tracing.turn({
      agentName: "support",
      identity: { ...identity, turnId: "dropped" },
      sequence: 1,
      reference: { ...reference, traceId: "b".repeat(32) },
    });
    expect(dropped.reference.traceFlags).toBe(0);
  });

  it("starts a fresh turn when the checkpoint is unusable", async () => {
    const { checkpointer, entries } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();
    const errors: string[] = [];
    const idGenerator = new AgentSpanIdGenerator();
    const tracing = createAgentTracing({
      telemetry: otelTelemetry({
        provider: new BasicTracerProvider({
          idGenerator,
          spanProcessors: [new SimpleSpanProcessor(exporter)],
        }),
        idGenerator,
      }),
      checkpointer: {
        ...checkpointer,
        get: () => ({ version: 1, key: "corrupt" }),
      },
      onError: (_error, context) => errors.push(context.phase),
    });
    const turn = await tracing.turn({ agentName: "support", identity, sequence: 0 });
    await turn.complete();
    expect(errors).toEqual(["restore"]);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["invoke_agent support"]);
    expect(entries.size).toBe(0);
  });

  it("requires stable span IDs", () => {
    expect(() =>
      createAgentTracing({
        telemetry: otelTelemetry({ provider: new BasicTracerProvider() }),
        checkpointer: memoryCheckpointer().checkpointer,
      }),
    ).toThrow(/AgentSpanIdGenerator/u);
  });
});
