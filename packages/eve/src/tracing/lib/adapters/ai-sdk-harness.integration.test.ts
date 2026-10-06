import { HarnessAgent } from "@ai-sdk/harness/agent";
import type { HarnessV1, HarnessV1PromptControl, HarnessV1StreamPart } from "@ai-sdk/harness";
import type { Experimental_SandboxSession as SandboxSession } from "@ai-sdk/provider-utils";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  createAgentTracing,
  modelUsage,
  otelTelemetry,
  type ActionOperation,
  type AgentTracing,
  type AttemptOperation,
  type ModelOperation,
  type ToolOperation,
  type TurnOperation,
} from "@vercel/agent-tracing";

// Consumer-side translation: HarnessAgent owns execution; the library owns spans.
type HarnessTelemetry = Exclude<
  NonNullable<
    NonNullable<ConstructorParameters<typeof HarnessAgent>[0]["telemetry"]>["integrations"]
  >,
  readonly unknown[]
>;

function harnessTelemetry(tracing: AgentTracing, runId: string): HarnessTelemetry {
  const identity = { conversationId: "conversation", runId, turnId: "turn" };
  let turn: TurnOperation | undefined;
  let attempt: AttemptOperation | undefined;
  let model: ModelOperation | undefined;
  const actions = new Map<string, { action: ActionOperation; tool: ToolOperation }>();
  return {
    executeTool({ toolCallId, execute }) {
      const operation = actions.get(toolCallId)?.tool;
      return operation === undefined ? execute() : operation.run(execute);
    },
    async onStart() {
      turn = await tracing.turn({
        agentName: "support",
        identity,
        sequence: 0,
        framework: { name: "ai-sdk-harness", version: "1" },
      });
    },
    async onStepStart(event) {
      attempt = await turn?.attempt({ stepIndex: event.stepNumber, attempt: 0 });
    },
    async onLanguageModelCallStart(event) {
      model = await attempt?.modelCall({ provider: event.provider, modelId: event.modelId });
    },
    async onLanguageModelCallEnd(event) {
      await model?.complete({
        outcome: "completed",
        result: { finishReason: event.finishReason, usage: modelUsage(event.usage) },
      });
      model = undefined;
    },
    async onToolExecutionStart(event) {
      const action = await attempt?.action({
        callId: event.toolCall.toolCallId,
        name: event.toolCall.toolName,
      });
      if (action !== undefined)
        actions.set(event.toolCall.toolCallId, { action, tool: await action.toolExecution() });
    },
    async onToolExecutionEnd(event) {
      const output = event.toolOutput;
      const completion =
        output.type === "tool-error"
          ? {
              outcome: "failed" as const,
              errorType: output.error instanceof Error ? output.error.name : "tool_error",
              error: output.error,
            }
          : { outcome: "completed" as const };
      const handles = actions.get(event.toolCall.toolCallId);
      await handles?.tool.complete(completion);
      await handles?.action.complete(completion);
      actions.delete(event.toolCall.toolCallId);
    },
    async onStepEnd() {
      await attempt?.complete({ outcome: "completed" });
      attempt = undefined;
    },
    async onEnd(event) {
      if (!("totalUsage" in event)) return;
      await turn?.complete({ outcome: "completed", usage: modelUsage(event.totalUsage) });
      turn = undefined;
    },
    async onError(error) {
      await turn?.fail(error);
    },
  };
}

const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
};
const finishReason = { unified: "stop" as const, raw: undefined };

function scriptedHarness(toolFails: boolean): HarnessV1 {
  function prompt({
    emit,
  }: {
    emit: (event: HarnessV1StreamPart) => void;
  }): Promise<HarnessV1PromptControl> {
    const done = Promise.resolve().then(() => {
      emit({ type: "stream-start", modelId: "test-model" });
      emit({
        type: "tool-call",
        toolCallId: "lookup-1",
        toolName: "lookup",
        input: "{}",
        providerExecuted: true,
      });
      emit({
        type: "tool-result",
        toolCallId: "lookup-1",
        toolName: "lookup",
        result: toolFails ? "Private tool error" : "Private tool result",
        isError: toolFails,
      });
      emit({ type: "finish-step", finishReason: { unified: "tool-calls", raw: undefined }, usage });
      emit({ type: "text-start", id: "answer" });
      emit({ type: "text-delta", id: "answer", delta: "Alice's answer" });
      emit({ type: "text-end", id: "answer" });
      emit({ type: "finish-step", finishReason, usage });
      emit({
        type: "finish",
        finishReason,
        totalUsage: {
          ...usage,
          inputTokens: { ...usage.inputTokens, total: 6 },
          outputTokens: { ...usage.outputTokens, total: 4 },
        },
      });
    });
    return Promise.resolve({ done, async submitToolResult() {} });
  }
  const unsupported = async (): Promise<never> => {
    throw new Error("Not used by this harness turn");
  };
  return {
    specificationVersion: "harness-v1",
    harnessId: "scripted",
    builtinTools: { lookup: { inputSchema: z.object({}) } },
    async doStart({ sessionId }) {
      return {
        sessionId,
        isResume: false,
        doPromptTurn: prompt,
        doContinueTurn: prompt,
        doCompact: unsupported,
        doSuspendTurn: unsupported,
        doDetach: unsupported,
        doStop: unsupported,
        async doDestroy() {},
      };
    },
  };
}

const sandbox: SandboxSession = {
  description: "In-memory harness test sandbox",
  async run() {
    return { exitCode: 0, stdout: "/workspace\n", stderr: "" };
  },
  async readFile() {
    return null;
  },
  async readBinaryFile() {
    return null;
  },
  async readTextFile() {
    return null;
  },
  async writeFile() {},
  async writeBinaryFile() {},
  async writeTextFile() {},
  async spawn() {
    throw new Error("The scripted harness does not spawn processes");
  },
};

describe("AI SDK HarnessAgent consumer", () => {
  it.each(["generate", "stream"] as const)(
    "records a real HarnessAgent %s lifecycle using only the package root",
    async (method) => {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      const tracing = createAgentTracing({ telemetry: otelTelemetry({ provider }) });
      const agent = new HarnessAgent({
        harness: scriptedHarness(method === "stream"),
        telemetry: { integrations: [harnessTelemetry(tracing, method)] },
      });
      const session = await agent.createSession({ sandboxSession: sandbox });
      try {
        let text = "";
        if (method === "generate")
          text = (await agent.generate({ session, prompt: "Help Alice inspect her project." }))
            .text;
        else {
          const result = await agent.stream({ session, prompt: "Help Alice inspect her project." });
          for await (const chunk of result.textStream) {
            text += chunk;
            expect(
              exporter.getFinishedSpans().some((span) => span.name === "invoke_agent support"),
            ).toBe(false);
          }
        }
        expect(text).toBe("Alice's answer");
        const spans = exporter.getFinishedSpans();
        const turn = spans.find((span) => span.name === "invoke_agent support")!;
        const attempts = spans.filter((span) => span.name === "agent.step");
        const models = spans.filter((span) => span.name === "chat test-model");
        const action = spans.find((span) => span.name === "agent.action")!;
        const tool = spans.find((span) => span.name === "execute_tool lookup")!;
        expect(spans).toHaveLength(7);
        expect(attempts).toHaveLength(2);
        expect(models).toHaveLength(2);
        expect(
          attempts.every((span) => span.parentSpanContext?.spanId === turn.spanContext().spanId),
        ).toBe(true);
        expect(
          models.every((span) =>
            attempts.some(
              (attempt) => span.parentSpanContext?.spanId === attempt.spanContext().spanId,
            ),
          ),
        ).toBe(true);
        expect(action.parentSpanContext?.spanId).toBe(attempts[0]!.spanContext().spanId);
        expect(tool.parentSpanContext?.spanId).toBe(action.spanContext().spanId);
        expect(tool.status.code).toBe(method === "stream" ? 2 : 0);
        expect(turn.attributes).toMatchObject({
          "agent.trace.schema.version": 4,
          "agent.framework.name": "ai-sdk-harness",
          "gen_ai.usage.input_tokens": 6,
          "gen_ai.usage.output_tokens": 4,
        });
        // Metadata-only capture is the default, so prompt and tool content stay out.
        expect(JSON.stringify(spans.map((span) => span.attributes))).not.toMatch(/Private|Alice/);
        expect(
          spans.every((span) =>
            Object.keys(span.attributes).every((key) => !key.startsWith("eve.")),
          ),
        ).toBe(true);
      } finally {
        await session.destroy();
        await tracing.shutdown();
        context.disable();
      }
    },
  );
});
