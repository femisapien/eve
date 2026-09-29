import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextContainer } from "#context/container.js";
import { AuthKey, InitiatorAuthKey, SessionIdKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { turnStep } from "#execution/session/turn-step.js";
import { runSessionStateStep } from "#internal/testing/session-state-step.js";
import type { DurableStepResult, TurnStepPayload } from "#execution/session/turn-step-types.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { defineInteractiveAuthorization } from "#shared/connection-types.js";
import { openApprovalRequests, readTurnState } from "#harness/turn-state.js";
import type { HarnessSession } from "#harness/types.js";
import { defineOpenAPIConnection } from "#public/definitions/connections/openapi.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import {
  BundleKey,
  ChannelKey,
  type CompiledBundle,
} from "#runtime/sessions/runtime-context-keys.js";
import { createRuntimeHookRegistry } from "#runtime/hooks/registry.js";
import { resolveRuntimeModelReference } from "#runtime/agent/resolve-model.js";
import type {
  ResolvedDynamicConnectionResolver,
  ResolvedDynamicToolResolver,
} from "#runtime/types.js";
import connectionSearch from "#tools/framework/connection-search.js";
import { clearDurableDynamicCallbacks } from "#tools/durable-callbacks.js";
import type { ApprovalResponseContext } from "#approval/definition.js";

// The harness runs outside a workflow body here, where run attributes cannot
// be written; the attribute contract is covered by emit.test.ts.
vi.mock("#runtime/attributes/emit.js", () => ({ setEveAttributes: vi.fn(async () => {}) }));

vi.mock("#runtime/sessions/compiled-agent-cache.js", () => ({
  getCompiledRuntimeAgentBundle: vi.fn(),
}));
vi.mock("#runtime/agent/resolve-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#runtime/agent/resolve-model.js")>()),
  resolveRuntimeModelReference: vi.fn(),
}));

const alice = {
  attributes: {},
  authenticator: "test",
  principalId: "alice",
  principalType: "user" as const,
};
const bob = { ...alice, principalId: "bob" };
const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};
const sessionId = "turn-connection-approval";

function modelResponse(toolName?: string, callId?: string, connection = "notes") {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...(toolName
          ? [
              {
                type: "tool-call" as const,
                toolCallId: callId ?? (toolName === "connection_search" ? "search" : "save"),
                toolName,
                input: JSON.stringify(
                  toolName === "connection_search"
                    ? { connection, keywords: "save" }
                    : { body: { note: "hello" } },
                ),
              },
            ]
          : [
              { type: "text-start" as const, id: "reply" },
              { type: "text-delta" as const, id: "reply", delta: "Saved." },
              { type: "text-end" as const, id: "reply" },
            ]),
        {
          type: "finish" as const,
          finishReason: {
            raw: undefined,
            unified: toolName ? ("tool-calls" as const) : ("stop" as const),
          },
          usage,
        },
      ],
    }),
  };
}

function setup(
  scope: "turn.started" | "session.started" = "turn.started",
  reject = false,
  variation?: "destination" | "name" | "request-only",
) {
  const response = vi.fn((context: ApprovalResponseContext) => {
    expect(context.response.principal.principalId).toBe("bob");
    expect(context.session.initiator?.principalId).toBe("alice");
    return reject
      ? { status: "rejected" as const, reason: "Only the notes owner can approve." }
      : { status: "allowed" as const };
  });
  const policyTurns: string[] = [];
  let removed = false;
  const resolver = vi.fn((event: unknown) => {
    if (removed) return {};
    const sequence = (event as { data: { sequence?: number } }).data.sequence ?? 0;
    return {
      [variation === "name" && sequence > 0 ? "second-notes" : "notes"]: defineOpenAPIConnection({
        baseUrl:
          variation === "destination"
            ? `https://notes-${sequence}.example.com`
            : "https://notes.example.com",
        instanceKey: variation === "destination" ? `turn-${sequence}` : undefined,
        description: "Save notes",
        spec: {
          openapi: "3.0.0",
          info: { title: "Notes", version: "1.0.0" },
          paths: {
            "/notes": {
              post: {
                operationId: "saveNote",
                summary: "Save a note",
                requestBody: {
                  required: true,
                  content: {
                    "application/json": {
                      schema: {
                        type: "object",
                        properties: { note: { type: "string" } },
                        required: ["note"],
                      },
                    },
                  },
                },
                responses: { 200: { description: "Saved" } },
              },
            },
          },
        },
        approval: {
          request: () => "user-approval",
          response:
            variation === "request-only"
              ? undefined
              : (context) => {
                  policyTurns.push(
                    (event as { data: { turnId?: string } }).data.turnId ?? "session",
                  );
                  return response(context);
                },
        },
      }),
    };
  });
  const dynamicConnectionResolvers: ResolvedDynamicConnectionResolver[] = [
    {
      eventNames: [scope],
      events: { [scope]: resolver },
      logicalPath: "connections/notes.ts",
      slug: "notes",
      sourceId: "notes",
      sourceKind: "module",
    },
  ];
  const dynamicToolResolvers: ResolvedDynamicToolResolver[] = [
    {
      eventNames: ["step.started"],
      events: connectionSearch.events as ResolvedDynamicToolResolver["events"],
      logicalPath: "tools/connection-search.ts",
      slug: "connection-search",
      sourceId: "eve:connection-search",
      sourceKind: "module",
    },
  ];
  const adapter = { kind: "test" };
  const turnAgent = {
    id: "notes-agent",
    instructions: ["Save notes."],
    model: { id: "test" },
    skills: [],
    tools: [],
    workspaceSpec: { rootEntries: [] },
  };
  const resolvedAgent: Partial<CompiledBundle["resolvedAgent"]> = {
    connections: [],
    dynamicConnectionResolvers,
    dynamicToolResolvers,
  };
  const sandboxRegistry: {
    sandbox: CompiledBundle["graph"]["root"]["sandboxRegistry"]["sandbox"] | null;
  } = { sandbox: null };
  const bundle = {
    adapterRegistry: { adaptersByKind: new Map([[adapter.kind, adapter]]) },
    compiledArtifactsSource: { kind: "bundled" },
    graph: {
      nodesByNodeId: new Map(),
      root: {
        agent: resolvedAgent as CompiledBundle["resolvedAgent"],
        sandboxRegistry: sandboxRegistry as CompiledBundle["graph"]["root"]["sandboxRegistry"],
        turnAgent,
        channels: [],
        hookRegistry: createRuntimeHookRegistry([]),
        nodeId: "__root__",
        subagentRegistry: {
          dynamicNodeIds: new Set(),
          dynamicResolvers: [],
          preparedTools: [],
          subagentsByName: new Map(),
          subagentsByNodeId: new Map(),
        },
        toolRegistry: { preparedTools: [], toolsByName: new Map() },
      },
    },
    hookRegistry: createRuntimeHookRegistry([]),
    moduleMap: { nodes: {} },
    resolvedAgent: resolvedAgent as CompiledBundle["resolvedAgent"],
    subagentRegistry: {
      dynamicNodeIds: new Set(),
      dynamicResolvers: [],
      preparedTools: [],
      subagentsByName: new Map(),
      subagentsByNodeId: new Map(),
    },
    toolRegistry: { preparedTools: [], toolsByName: new Map() },
    turnAgent,
  } as CompiledBundle;
  vi.mocked(getCompiledRuntimeAgentBundle).mockResolvedValue(bundle);
  const doStream = vi
    .fn()
    .mockImplementationOnce(() => modelResponse("connection_search"))
    .mockImplementationOnce(() => modelResponse("notes__saveNote"))
    .mockImplementation(() => modelResponse());
  vi.mocked(resolveRuntimeModelReference).mockResolvedValue(new MockLanguageModelV4({ doStream }));
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ saved: true }), {
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const ctx = new ContextContainer();
  ctx.set(AuthKey, alice);
  ctx.set(InitiatorAuthKey, alice);
  ctx.set(BundleKey, bundle);
  ctx.set(ChannelKey, adapter);
  ctx.set(SessionIdKey, sessionId);
  ctx.set(CallbackBaseUrlKey, "https://agent.example.com");
  const session: HarnessSession = {
    agent: { modelReference: { id: "test" }, system: "Save notes.", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "notes-session",
    history: [],
    sessionId,
  };
  let snapshot = {
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session }),
  };
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  async function step(input?: TurnStepPayload): Promise<DurableStepResult> {
    const stepInput = {
      ...snapshot,
      input,
      sessionWritable: new WritableStream<Uint8Array>({
        write(chunk) {
          const text = new TextDecoder().decode(chunk);
          for (const line of text.split("\n")) {
            if (line.trim()) events.push(JSON.parse(line));
          }
        },
      }),
    };
    const result = await runSessionStateStep(stepInput, turnStep);
    snapshot = { serializedContext: result.serializedContext, sessionState: result.sessionState };
    return result;
  }
  return {
    doStream,
    events,
    fetch,
    resolver,
    response,
    step,
    policyTurns,
    removeConnection() {
      removed = true;
    },
    updateSession(update: (session: HarnessSession) => HarnessSession) {
      snapshot = {
        ...snapshot,
        sessionState: createDurableSessionState({
          session: update({
            ...session,
            ...readDurableSession(snapshot.sessionState),
            agent: session.agent,
            compaction: session.compaction,
          }),
        }),
      };
    },
  };
}

afterEach(() => {
  clearDurableDynamicCallbacks(sessionId);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("turn connection approval sign-ins", () => {
  it("names the responder, not the requester, on a candidate's sign-in events", async () => {
    const signIn = defineInteractiveAuthorization<{ readonly nonce: string }>({
      async getToken() {
        throw new ConnectionAuthorizationRequiredError("notes-approver");
      },
      async startAuthorization() {
        return { challenge: { url: "https://idp.example/sign-in" }, resume: { nonce: "n1" } };
      },
      async completeAuthorization() {
        return { token: "approver-token" };
      },
    });
    const fixture = setup();
    fixture.response.mockImplementation(((context: ApprovalResponseContext) =>
      context.auth
        .getToken(signIn, { authKey: "notes-approver" })
        .then(() => ({ status: "allowed" as const }))) as never);
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's note for Bob." }] },
    });
    const parked = await fixture.step();
    const request = openApprovalRequests(
      readTurnState(readDurableSession(parked.sessionState).state),
    )[0]!;

    const signInStart = fixture.events.length;
    await fixture.step({
      delivery: {
        kind: "deliver",
        auth: bob,
        payloads: [{ inputResponses: [{ requestId: request.requestId, optionId: "approve" }] }],
      },
    });
    // Ingesting the candidate, running its policy, and parking on sign-in are separate passes.
    for (let result = await fixture.step(); result.action === "continue";) {
      result = await fixture.step();
    }
    const candidate = fixture.events
      .slice(signInStart)
      .find((event) => event.type === "approval.candidate");
    const required = fixture.events
      .slice(signInStart)
      .find((event) => event.type === "authorization.required");
    expect(candidate?.data).toMatchObject({ responderPrincipalId: "bob" });
    expect(required?.data).toMatchObject({
      attemptId: expect.any(String),
      candidateId: candidate?.data.candidateId,
      principalId: "bob",
    });

    const completionStart = fixture.events.length;
    await fixture.step({
      delivery: {
        kind: "deliver",
        payloads: [
          {
            authorizationCallback: {
              attemptId: required?.data.attemptId,
              callback: { method: "GET", params: { code: "ok" } },
              connectionName: required?.data.name,
            },
          },
        ],
      },
    });
    const completed = fixture.events
      .slice(completionStart)
      .find((event) => event.type === "authorization.completed");
    expect(completed?.data).toMatchObject({
      attemptId: required?.data.attemptId,
      outcome: "authorized",
      principalId: "bob",
    });
  });
});
