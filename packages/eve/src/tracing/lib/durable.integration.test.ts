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
    agentName: "support",
    telemetry: otelTelemetry({ provider, idGenerator }),
    checkpointer,
  });
}

describe("durable agent tracing", () => {
  it("continues a turn in a new worker by calling the same operations again", async () => {
    const { checkpointer, entries } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();

    const first = worker(checkpointer, exporter);
    const turn = await first.turn({ identity, sequence: 0 });
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
    const resumedTurn = await second.turn({ identity, sequence: 0 });
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

  it("starts a fresh turn when the checkpoint is unusable", async () => {
    const { checkpointer, entries } = memoryCheckpointer();
    const exporter = new InMemorySpanExporter();
    const errors: string[] = [];
    const idGenerator = new AgentSpanIdGenerator();
    const tracing = createAgentTracing({
      agentName: "support",
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
    const turn = await tracing.turn({ identity, sequence: 0 });
    await turn.complete();
    expect(errors).toEqual(["restore"]);
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["invoke_agent support"]);
    expect(entries.size).toBe(0);
  });

  it("requires stable span IDs", () => {
    expect(() =>
      createAgentTracing({
        agentName: "support",
        telemetry: otelTelemetry({ provider: new BasicTracerProvider() }),
        checkpointer: memoryCheckpointer().checkpointer,
      }),
    ).toThrow(/AgentSpanIdGenerator/u);
  });
});
