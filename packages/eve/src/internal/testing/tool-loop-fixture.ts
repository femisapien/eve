import { jsonSchema, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { vi, type Mock } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionKey } from "#context/keys.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { openApprovalRequests, readTurnState } from "#harness/turn-state.js";
import type { HarnessSession, StepInput, ToolLoopHarnessConfig } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { always } from "#tools/approval/policies.js";

// Drives the tool-loop harness over a mock AI SDK model, for integration tests.

export type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

export function streamOf(chunks: StreamPart[], finish: "stop" | "tool-calls"): StreamResult {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start", warnings: [] },
        ...chunks,
        { finishReason: { raw: undefined, unified: finish }, type: "finish", usage },
      ],
    }),
  };
}

/** A model response that answers in text. */
export const text = (value: string): StreamResult =>
  streamOf(
    [
      { id: "answer", type: "text-start" },
      { delta: value, id: "answer", type: "text-delta" },
      { id: "answer", type: "text-end" },
    ],
    "stop",
  );

/** A model response that calls these tools, as `call-0`, `call-1`, and so on. */
export const calls = (...toolNames: string[]): StreamResult =>
  streamOf(
    toolNames.map((toolName, index) => ({
      input: JSON.stringify({ target: `${toolName}-${index}` }),
      toolCallId: `call-${index}`,
      toolName,
      type: "tool-call" as const,
    })),
    "tool-calls",
  );

/** An approval-gated tool that runs inline. */
export function inlineTool(name: string, execute = vi.fn(async () => `${name} done`)) {
  return {
    approval: always(),
    description: name,
    execute,
    inputSchema: jsonSchema({ type: "object" }),
    name,
  } satisfies HarnessToolDefinition;
}

/** An approval-gated tool that runs as a workflow. */
export function workflowTool(name: string): HarnessToolDefinition {
  return {
    approval: always(),
    description: name,
    inputSchema: jsonSchema({ type: "object" }),
    name,
    workflowId: `workflow//./agent/tools/${name}//execute`,
  };
}

export interface ToolLoopFixture {
  readonly config: ToolLoopHarnessConfig;
  readonly ctx: ContextContainer;
  readonly doStream: Mock<MockLanguageModelV4["doStream"]>;
  readonly events: UnstampedMessageStreamEvent[];
  readonly eventsSince: (start: number) => string[];
  readonly session: HarnessSession;
  readonly step: (
    current: HarnessSession,
    input?: StepInput,
    stepConfig?: ToolLoopHarnessConfig,
  ) => ReturnType<ReturnType<typeof createToolLoopHarness>>;
}

/**
 * A tool-loop harness over a mock model that answers with `responses`, then
 * with text, run in a context whose caller is Alice.
 */
export function setup(
  tools: readonly HarnessToolDefinition[],
  responses: readonly StreamResult[],
  overrides: Partial<ToolLoopHarnessConfig> = {},
): ToolLoopFixture {
  const events: UnstampedMessageStreamEvent[] = [];
  const doStream = vi.fn<MockLanguageModelV4["doStream"]>();
  for (const response of responses) doStream.mockResolvedValueOnce(response);
  doStream.mockResolvedValue(text("Done."));
  const model = new MockLanguageModelV4({
    doStream,
    modelId: "turn-state-model",
    provider: "eve-integration-mock",
  });
  const config: ToolLoopHarnessConfig = {
    capabilities: { requestInput: true },
    handleEvent: async (event) => {
      events.push(event);
    },
    resolveModel: async () => model,
    tools: new Map(tools.map((tool) => [tool.name, tool])),
    ...overrides,
  };
  const ctx = new ContextContainer();
  const alice = {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId: "alice",
    principalType: "user" as const,
  };
  ctx.set(AuthKey, alice);
  ctx.set(SessionIdKey, "turn-state");
  ctx.set(SessionKey, {
    auth: { current: alice, initiator: alice },
    sessionId: "turn-state",
    turn: { id: "turn_0", sequence: 0 },
  });
  const session: HarnessSession = {
    agent: { modelReference: { id: "turn-state-model" }, system: "Help Alice.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:turn-state",
    history: [],
    sessionId: "turn-state",
  };
  const step = (current: HarnessSession, input?: StepInput, stepConfig = config) =>
    contextStorage.run(ctx, () => createToolLoopHarness(stepConfig)(current, input));
  const eventsSince = (start: number) => events.slice(start).map((event) => event.type);
  return { config, ctx, doStream, events, eventsSince, session, step };
}

export function requestIds(session: HarnessSession): string[] {
  return openApprovalRequests(readTurnState(session.state)).map((request) => request.requestId);
}

/** Answers every open approval the same way. */
export function answer(session: HarnessSession, optionId: "approve" | "cancel"): StepInput {
  return {
    inputResponses: requestIds(session).map((requestId) => ({ optionId, requestId })),
  };
}

export function toolResultIds(session: HarnessSession): string[] {
  return session.history.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.toolCallId] : []))
      : [],
  );
}

/** A model response that calls tools under the given call IDs. */
export function toolCalls(
  entries: readonly {
    readonly callId: string;
    readonly toolName: string;
    readonly input?: object;
  }[],
): StreamResult {
  return streamOf(
    entries.map(({ callId, input, toolName }) => ({
      input: JSON.stringify(input ?? {}),
      toolCallId: callId,
      toolName,
      type: "tool-call" as const,
    })),
    "tool-calls",
  );
}
