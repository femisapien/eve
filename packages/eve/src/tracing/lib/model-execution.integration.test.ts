import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createAgentTracing } from "./index.js";

describe("wrapped model streams", () => {
  it.each(["completed", "failed", "cancelled"])(
    "preserves the stream and waits for %s completion",
    async (outcome) => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      const tracing = createAgentTracing({ agentName: "stream", provider });
      try {
        const turn = await tracing.turn({
          identity: { conversationId: "c", runId: "r", turnId: "t" },
          sequence: 0,
        });
        const attempt = await turn.attempt({ stepIndex: 0, attempt: 0 });
        const completion = Promise.withResolvers<{
          finishReason: string;
          usage: { inputTokens: number };
        }>();
        const source = new ReadableStream<string>({}, { highWaterMark: 0 });
        const stream = await attempt.modelStream({ provider: "test", modelId: "model" }, () => ({
          result: source,
          completion: completion.promise,
        }));
        expect(stream).toBe(source);
        let ended = false;
        const ending = turn.complete().then(() => {
          ended = true;
        });
        await Promise.resolve();
        expect(ended).toBe(false);
        if (outcome === "completed")
          completion.resolve({ finishReason: "stop", usage: { inputTokens: 3 } });
        else
          completion.reject(
            outcome === "failed"
              ? new TypeError("private")
              : new DOMException("Cancelled", "AbortError"),
          );
        await ending;
        expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
          "chat model",
          "agent.step",
          "invoke_agent stream",
        ]);
        expect(exporter.getFinishedSpans()[0]!.status.code).toBe(outcome === "completed" ? 0 : 2);
      } finally {
        await tracing.shutdown();
      }
    },
  );
});
