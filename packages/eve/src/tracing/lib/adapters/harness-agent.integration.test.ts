import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { context } from "@opentelemetry/api";
import { createAgentTracing } from "../index.js";

describe("outside-eve agent", () => {
  it("runs wrapped operations and handle-based tools using only the facade", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    const tracing = createAgentTracing({ agentName: "support", provider });
    try {
      const value = await tracing.turn(
        { identity: { conversationId: "conversation", runId: "run", turnId: "turn" }, sequence: 0 },
        (turn) =>
          turn.attempt({ stepIndex: 0, attempt: 0 }, async (attempt) => {
            const answer = await attempt.modelCall({ provider: "test", modelId: "model" }, () => ({
              result: "answer",
              finishReason: "stop",
              usage: { inputTokens: 3, outputTokens: 2 },
            }));
            expect(answer).toBe("answer");
            return attempt.action({ callId: "lookup", name: "lookup" }, async (action) => {
              await action.approval(
                { requestId: "approval", describe: () => ({ outcome: "approved" }) },
                () => true,
              );
              const tool = await action.toolExecution();
              const result = tool.run(() => "Alice's answer");
              await tool.complete({ outcome: "completed", output: result });
              return result;
            });
          }),
      );
      expect(value).toBe("Alice's answer");
      await tracing.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans.map((span) => span.name)).toEqual([
        "chat model",
        "agent.approval",
        "execute_tool lookup",
        "agent.action",
        "agent.step",
        "invoke_agent support",
      ]);
      const turn = spans.at(-1)!;
      expect(spans.find((span) => span.name === "agent.step")?.parentSpanContext?.spanId).toBe(
        turn.spanContext().spanId,
      );
      expect(turn.attributes["gen_ai.usage.input_tokens"]).toBe(3);
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain("Alice");
      const handle = await tracing.turn({
        identity: { conversationId: "conversation", runId: "next", turnId: "turn" },
        sequence: 0,
      });
      expect(handle).not.toHaveProperty("snapshot");
      expect(tracing).not.toHaveProperty("resume");
      await handle.complete();
    } finally {
      await tracing.shutdown();
      context.disable();
      manager.disable();
    }
  });
});
