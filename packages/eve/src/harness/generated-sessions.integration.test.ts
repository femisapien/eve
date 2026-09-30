import { jsonSchema } from "ai";
import { describe, it, vi } from "vitest";
import { type ContextContainer, contextStorage } from "#context/container.js";
import { workflowToolRunRequestToInputRequestPayload } from "#execution/tools/workflow/owner-inbox.js";
import { requestAuthorization } from "#harness/authorization.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { upsertProxyInputRequests } from "#harness/proxy-input-requests.js";
import { cancelTurn } from "#harness/session-lifecycle.js";
import { stashToolInterrupt } from "#harness/tool-interrupts.js";
import {
  allCalls,
  callOrigin,
  openApprovalRequests,
  readTurnState,
  startWorkflowCall,
  writeTurnState,
} from "#harness/turn-state.js";
import type { HandleEventFn, HarnessSession, StepInput } from "#harness/types.js";
import { setup, text, toolCalls } from "#internal/testing/tool-loop-fixture.js";
import { emitProxiedInputRequest } from "#subagents/hitl-proxy.js";
import { always } from "#tools/approval/policies.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

/**
 * Drives sessions through random sequences of what people and the runtime do
 * (messages, answers, steering, workflow results, requests a workflow run
 * passes up, cancels, clears) with a model that calls tools at random,
 * including tools that ask for a sign-in, and checks after every action that
 * the stream keeps its contract and shows what the session awaits.
 * Hand-written tests cover the sequences someone thought of; this covers the
 * rest. Answers routed down to a run and sign-in callbacks happen outside the
 * harness, so their own tests cover them.
 *
 * Raise `EVE_GENERATED_SESSIONS` to explore more seeds locally.
 */
const SEEDS = Number(process.env.EVE_GENERATED_SESSIONS ?? 40);
const ACTIONS_PER_SESSION = 14;

const signInContext: { ctx?: ContextContainer; attempts: number } = { attempts: 0 };

const TOOLS: readonly HarnessToolDefinition[] = [
  inlineTool("deploy", true),
  inlineTool("lookup", false),
  signInTool("notes", false),
  signInTool("release", true),
  workflowTool("build", false),
  workflowTool("publish", true),
];

describe("generated sessions", () => {
  it.each(Array.from({ length: SEEDS }, (_, seed) => seed))(
    "keeps the stream contract through seed %i",
    generateSession,
  );
});

type Action =
  | { readonly kind: "answer"; readonly responses: StepInput["inputResponses"] }
  | { readonly kind: "cancel" }
  | { readonly kind: "clear" }
  | { readonly kind: "message"; readonly message: string }
  | { readonly kind: "relay"; readonly callId: string }
  | { readonly kind: "result"; readonly callIds: readonly string[] }
  | {
      readonly kind: "steer";
      readonly message: string;
      readonly responses: StepInput["inputResponses"];
    };

async function generateSession(seed: number): Promise<void> {
  const random = mulberry32(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const fixture = setup(TOOLS, []);
  let calls = 0;
  let modelSteps = 0;
  fixture.doStream.mockImplementation(async () => {
    modelSteps += 1;
    if (modelSteps > 3 || random() < 0.35) return text(`Reply ${String(modelSteps)}.`);
    const count = 1 + Math.floor(random() * 3);
    return toolCalls(
      Array.from({ length: count }, () => ({
        callId: `call-${String(calls++)}`,
        toolName: pick(TOOLS).name,
      })),
    );
  });
  const { config, ctx, events } = fixture;
  const emit = config.handleEvent!;
  signInContext.ctx = ctx;
  let relays = 0;
  let session = fixture.session;
  const actions: Action[] = [];

  const drive = async (input: StepInput | undefined, stepConfig = config) => {
    modelSteps = 0;
    const result = await fixture.drive(session, input, stepConfig);
    session = dispatchReadyWorkflows(result.session);
  };

  try {
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
              toolName: allCalls(readTurnState(session.state)).find(
                (call) => call.callId === callId,
              )!.toolName,
            })),
          });
          break;
        case "relay":
          session = await relayRequest(session, action.callId, String(relays++), emit);
          break;
        case "cancel":
          session = await contextStorage.run(ctx, () => cancelTurn(emit, session));
          break;
        case "clear":
          await drive(undefined, { ...config, clearOnly: true });
          break;
      }
      fixture.checkContract(session);
    }
  } catch (error) {
    throw new Error(
      [
        `Seed ${String(seed)} failed: ${error instanceof Error ? error.message : String(error)}`,
        "Actions:",
        ...actions.map((action, index) => `  ${String(index)}. ${JSON.stringify(action)}`),
        "Events:",
        ...events.map(
          (event) =>
            `  ${event.type} ${JSON.stringify("data" in event ? event.data : {}).slice(0, 160)}`,
        ),
      ].join("\n"),
      { cause: error },
    );
  }
}

/** A workflow call's run passes up an approval its subagent asks for, as the relay code does. */
async function relayRequest(
  session: HarnessSession,
  callId: string,
  relay: string,
  emit: HandleEventFn,
): Promise<HarnessSession> {
  const turnState = readTurnState(session.state);
  const call = allCalls(turnState).find((candidate) => candidate.callId === callId)!;
  const origin = callOrigin(turnState, call.callId)!;
  const hookPayload = workflowToolRunRequestToInputRequestPayload({
    from: {
      callId: call.callId,
      input: {},
      runId: call.workflow!.run!.runId,
      ...origin,
      toolName: call.toolName,
    },
    replyTo: `reply-${relay}`,
    request: {
      kind: "input-batch",
      requests: [
        {
          action: {
            callId: `subagent-call-${relay}`,
            input: {},
            kind: "tool-call",
            toolName: "deploy",
          },
          kind: "tool-approval",
          prompt: "Deploy Bob's build?",
          requestId: `relayed-${relay}`,
        },
      ],
    },
  });
  const entries = await emitProxiedInputRequest({
    emit,
    hookPayload,
    runId: call.workflow!.run!.runId,
    session,
  });
  return upsertProxyInputRequests({
    entries,
    forChildContinuationToken: hookPayload.childContinuationToken,
    session,
  });
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
    choices.push(() => ({ callId: pick(working).callId, kind: "relay" }));
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

/** A tool whose connection asks for a sign-in every time it runs. */
function signInTool(name: string, gated: boolean): HarnessToolDefinition {
  return {
    ...inlineTool(name, gated),
    execute: async (_input: unknown, options: { readonly toolCallId: string }) => {
      const attempt = String(signInContext.attempts++);
      stashToolInterrupt(
        signInContext.ctx!,
        options.toolCallId,
        requestAuthorization([
          {
            attemptId: `attempt-${attempt}`,
            challenge: { url: `https://idp.example/${name}` },
            hookUrl: `https://agent.example/callback/${attempt}`,
            name,
            principal: { type: "app" },
          },
        ]),
      );
      return "sign-in required";
    },
  };
}

/** Starts a run for each workflow call the harness readied, as execution does. */
function dispatchReadyWorkflows(session: HarnessSession): HarnessSession {
  let turnState = readTurnState(session.state);
  for (const call of allCalls(turnState)) {
    if (call.workflow === undefined || call.status !== "ready") continue;
    turnState = startWorkflowCall(turnState, call.callId, {
      hookToken: `hook-${call.callId}`,
      runId: `run-${call.callId}`,
    });
  }
  return writeTurnState(session, turnState);
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
