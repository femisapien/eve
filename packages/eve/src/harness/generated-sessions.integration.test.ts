import { jsonSchema, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionKey } from "#context/keys.js";
import { checkSessionAgreement } from "#execution/session-contract-monitor.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { cancelTurn } from "#harness/session-lifecycle.js";
import { allCalls, openApprovalRequests, readTurnState } from "#harness/turn-state.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import type { HarnessSession, StepInput, ToolLoopHarnessConfig } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  checkSessionEvent,
  initialSessionContractState,
  type SessionContractViolation,
} from "#protocol/session-contract.js";
import { always } from "#tools/approval/policies.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

/**
 * Drives sessions through random sequences of what people and the runtime do
 * (messages, answers, steering, workflow results, cancels, clears) with a
 * model that answers at random, and checks after every action that the stream
 * keeps its contract and shows what the session awaits. Hand-written tests
 * cover the sequences someone thought of; this covers the rest.
 *
 * Raise `EVE_GENERATED_SESSIONS` to explore more seeds locally.
 */
const SEEDS = Number(process.env.EVE_GENERATED_SESSIONS ?? 40);
const ACTIONS_PER_SESSION = 14;

type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
type StreamPart = StreamResult["stream"] extends ReadableStream<infer Part> ? Part : never;

const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

const TOOLS: readonly HarnessToolDefinition[] = [
  inlineTool("deploy", true),
  inlineTool("lookup", false),
  workflowTool("build", false),
  workflowTool("publish", true),
];

describe("generated sessions", () => {
  it.each(Array.from({ length: SEEDS }, (_, seed) => seed))(
    "keeps the stream contract through seed %i",
    async (seed) => {
      const run = await generateSession(seed);
      expect(run.violations, run.describe()).toEqual([]);
    },
  );
});

type Action =
  | { readonly kind: "answer"; readonly responses: StepInput["inputResponses"] }
  | { readonly kind: "cancel" }
  | { readonly kind: "clear" }
  | { readonly kind: "message"; readonly message: string }
  | { readonly kind: "result"; readonly callIds: readonly string[] }
  | {
      readonly kind: "steer";
      readonly message: string;
      readonly responses: StepInput["inputResponses"];
    };

async function generateSession(seed: number) {
  const random = mulberry32(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const events: UnstampedMessageStreamEvent[] = [];
  let calls = 0;
  let modelSteps = 0;
  const doStream = vi.fn<MockLanguageModelV4["doStream"]>(async () => {
    modelSteps += 1;
    if (modelSteps > 3 || random() < 0.35) return reply(`Reply ${String(modelSteps)}.`);
    const count = 1 + Math.floor(random() * 3);
    return toolCalls(
      Array.from({ length: count }, () => ({
        callId: `call-${String(calls++)}`,
        tool: pick(TOOLS),
      })),
    );
  });
  const model = new MockLanguageModelV4({
    doStream,
    modelId: "generated-model",
    provider: "eve-integration-mock",
  });
  const config: ToolLoopHarnessConfig = {
    capabilities: { requestInput: true },
    handleEvent: async (event) => {
      events.push(event);
    },
    resolveModel: async () => model,
    tools: new Map(TOOLS.map((tool) => [tool.name, tool])),
  };
  const ctx = sessionContext();
  let session: HarnessSession = {
    agent: { modelReference: { id: "generated-model" }, system: "Help Alice.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:generated",
    history: [],
    sessionId: "generated",
  };

  const actions: Action[] = [];
  const violations: (SessionContractViolation & { readonly after: number })[] = [];
  let contract = initialSessionContractState();
  let checked = 0;

  const drive = async (input: StepInput | undefined, stepConfig = config) => {
    modelSteps = 0;
    let result = await contextStorage.run(ctx, () =>
      createToolLoopHarness(stepConfig)(session, input),
    );
    while (typeof result.next === "function") {
      const next = result.next;
      const current = result.session;
      result = await contextStorage.run(ctx, () => next(current));
    }
    session = result.session;
  };

  for (let index = 0; index < ACTIONS_PER_SESSION; index += 1) {
    const action = nextAction(session, index, random, pick);
    actions.push(action);
    switch (action.kind) {
      case "message":
        await drive({ message: action.message });
        break;
      case "answer":
        await drive({ inputResponses: action.responses });
        break;
      case "steer":
        await drive({ inputResponses: action.responses, message: action.message });
        break;
      case "result":
        await drive({
          runtimeActionResults: action.callIds.map((callId) => ({
            callId,
            kind: "tool-result" as const,
            output: `${callId} finished`,
            toolName: allCalls(readTurnState(session.state)).find((call) => call.callId === callId)!
              .toolName,
          })),
        });
        break;
      case "cancel": {
        const emit = config.handleEvent!;
        session = await contextStorage.run(ctx, () => cancelTurn(emit, session));
        break;
      }
      case "clear":
        await drive(undefined, { ...config, clearOnly: true });
        break;
    }
    for (; checked < events.length; checked += 1) {
      const result = checkSessionEvent(contract, events[checked]!);
      contract = result.state;
      violations.push(...result.violations.map((violation) => ({ ...violation, after: index })));
    }
    violations.push(
      ...checkSessionAgreement(contract.projection, session.state).map((violation) => ({
        ...violation,
        after: index,
      })),
    );
    if (violations.length > 0) break;
  }

  return {
    violations,
    describe: () =>
      [
        `Seed ${String(seed)} broke the stream contract. Actions:`,
        ...actions.map((action, index) => `  ${String(index)}. ${JSON.stringify(action)}`),
        "Events:",
        ...events.map(
          (event) =>
            `  ${event.type} ${JSON.stringify("data" in event ? event.data : {}).slice(0, 160)}`,
        ),
      ].join("\n"),
  };
}

/** Picks something a person or the runtime could do next, given what the session awaits. */
function nextAction(
  session: HarnessSession,
  index: number,
  random: () => number,
  pick: <T>(values: readonly T[]) => T,
): Action {
  const turnState = readTurnState(session.state);
  const open = openApprovalRequests(turnState);
  const working = allCalls(turnState).filter(
    (call) => call.workflow !== undefined && (call.status === "ready" || call.status === "running"),
  );
  const responses = () => {
    const chosen = open.filter(() => random() < 0.6);
    return (chosen.length === 0 ? [pick(open)] : chosen).map((request) => ({
      optionId: random() < 0.7 ? "approve" : "cancel",
      requestId: request.requestId,
    }));
  };
  const message = `Alice's message ${String(index)}.`;
  const choices: (() => Action)[] = [() => ({ kind: "message", message })];
  if (open.length > 0) {
    choices.push(() => ({ kind: "answer", responses: responses() }));
    choices.push(() => ({ kind: "answer", responses: responses() }));
    choices.push(() => ({ kind: "steer", message, responses: responses() }));
  }
  if (working.length > 0) {
    choices.push(() => ({
      callIds: working.filter(() => random() < 0.6).map((call) => call.callId),
      kind: "result",
    }));
  }
  // A cancel stops the open turn; a clear waits for the session to be between turns.
  if (turnState.turn !== undefined) choices.push(() => ({ kind: "cancel" }));
  else if (index > 0) choices.push(() => ({ kind: "clear" }));
  const action = pick(choices)();
  return action.kind === "result" && action.callIds.length === 0
    ? { callIds: [working[0]!.callId], kind: "result" }
    : action;
}

function inlineTool(name: string, gated: boolean): HarnessToolDefinition {
  return {
    ...(gated && { approval: always() }),
    description: name,
    execute: async () => `${name} done`,
    inputSchema: jsonSchema({ type: "object" }),
    name,
  };
}

function workflowTool(name: string, gated: boolean): HarnessToolDefinition {
  return {
    ...(gated && { approval: always() }),
    description: name,
    inputSchema: jsonSchema({ type: "object" }),
    name,
    workflowId: `workflow//./agent/tools/${name}//execute`,
  };
}

function reply(text: string): StreamResult {
  return streamOf(
    [
      { id: "answer", type: "text-start" },
      { delta: text, id: "answer", type: "text-delta" },
      { id: "answer", type: "text-end" },
    ],
    "stop",
  );
}

function toolCalls(
  calls: readonly { readonly callId: string; readonly tool: HarnessToolDefinition }[],
): StreamResult {
  return streamOf(
    calls.map(({ callId, tool }) => ({
      input: JSON.stringify({ target: callId }),
      toolCallId: callId,
      toolName: tool.name,
      type: "tool-call" as const,
    })),
    "tool-calls",
  );
}

function streamOf(chunks: StreamPart[], finish: "stop" | "tool-calls"): StreamResult {
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

function sessionContext(): ContextContainer {
  const ctx = new ContextContainer();
  const alice = {
    attributes: {},
    authenticator: "test",
    issuer: "test",
    principalId: "alice",
    principalType: "user" as const,
  };
  ctx.set(AuthKey, alice);
  ctx.set(SessionIdKey, "generated");
  ctx.set(SessionKey, {
    auth: { current: alice, initiator: alice },
    sessionId: "generated",
    turn: { id: "turn_0", sequence: 0 },
  });
  return ctx;
}

/** A small seeded generator, so a failing seed replays exactly. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
