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
import connectionTools from "#tools/framework/connection-tools.js";
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
const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};
const sessionId = "turn-connections";

/** A model step that saves notes through `connection_execute`, or replies when `callId` is omitted. */
function modelResponse(callId?: string | readonly string[], connection = "notes") {
  const callIds = callId === undefined ? [] : typeof callId === "string" ? [callId] : callId;
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...(callIds.length > 0
          ? callIds.map((toolCallId) => ({
              type: "tool-call" as const,
              toolCallId,
              toolName: "connection_execute",
              input: JSON.stringify({
                connection,
                tool: "saveNote",
                input: { body: { note: "hello" } },
              }),
            }))
          : [
              { type: "text-start" as const, id: "reply" },
              { type: "text-delta" as const, id: "reply", delta: "Saved." },
              { type: "text-end" as const, id: "reply" },
            ]),
        {
          type: "finish" as const,
          finishReason: {
            raw: undefined,
            unified: callIds.length > 0 ? ("tool-calls" as const) : ("stop" as const),
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
  variation?: "destination" | "name" | "request-only" | "unapproved-name",
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
      [(variation === "name" || variation === "unapproved-name") && sequence > 0
        ? "second-notes"
        : "notes"]: defineOpenAPIConnection({
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
        approval:
          variation === "unapproved-name"
            ? undefined
            : {
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
      events: connectionTools.events as ResolvedDynamicToolResolver["events"],
      logicalPath: "tools/connection_tools.ts",
      slug: "connection_tools",
      sourceId: "eve:connection-tools",
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
    .mockImplementationOnce(() => modelResponse("save"))
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

describe("turn connections", () => {
  it("keeps the provider tools and system prompt identical while connections change", async () => {
    const fixture = setup("turn.started", false, "unapproved-name");
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's first note." }] },
    });
    await fixture.step();
    fixture.doStream.mockImplementationOnce(() => modelResponse("save-2", "second-notes"));
    await fixture.step({
      delivery: { kind: "deliver", payloads: [{ message: "Prepare Alice's second note." }] },
    });
    await fixture.step();
    expect(fixture.fetch).toHaveBeenCalledTimes(2);

    const requests = fixture.doStream.mock.calls.map(
      ([options]) =>
        options as {
          prompt: { role: string; content: unknown }[];
          tools: { name: string }[];
        },
    );
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const [first, ...later] = requests;
    expect(first!.tools.map((tool) => tool.name).sort()).toEqual([
      "connection_execute",
      "connection_search",
    ]);
    const system = (request: (typeof requests)[number]) =>
      request.prompt.filter((message) => message.role === "system");
    for (const request of later) {
      expect(request.tools).toEqual(first!.tools);
      expect(system(request)).toEqual(system(first!));
    }
    // Connection names reach the model only through appended context messages.
    const last = JSON.stringify(requests.at(-1)!.prompt);
    expect(JSON.stringify(system(first!))).not.toContain("- notes:");
    expect(last).toContain("- notes: Save notes");
    expect(last).toContain("- second-notes: Save notes");
  });
});
