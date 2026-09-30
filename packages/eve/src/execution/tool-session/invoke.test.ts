import { afterEach, describe, expect, it, vi } from "vitest";

import type { Approval } from "#approval/definition.js";
import type { InvokeToolOptions } from "#channel/invoke-tool.js";
import type { SessionAuthContext } from "#channel/types.js";
import { ConnectionAuthorizationRequiredError } from "#connections/errors.js";
import { shutdownActiveSandboxHandles } from "#execution/sandbox/active-handles.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import {
  invokeToolInSession,
  type ToolSessionManifest,
  type ToolSessionRuntime,
} from "#execution/tool-session/invoke.js";
import type { CompiledToolBehavior } from "#tools/behavior.js";
import {
  sweepToolSessionSandboxes,
  TOOL_SESSION_SANDBOX_EXPIRY_MS,
} from "#execution/tool-session/sandbox.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { mockSandbox, type MockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { defineState } from "#public/definitions/state.js";
import { defineSandbox } from "#public/definitions/sandbox.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type { AuthorizationDefinition } from "#shared/connection-types.js";
import {
  defineSandboxProvider,
  type SandboxProviderHandle,
  type SandboxProviderImplementation,
} from "#shared/sandbox-provider.js";
import {
  SandboxNameConflictError,
  type SandboxProviderNamedSessions,
  withNamedSandboxSessions,
} from "#execution/sandbox/named-sessions.js";
import type { ToolContext } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";

vi.mock("#runtime/sandbox/prepared-artifacts.js", () => ({
  loadSandboxPreparedArtifact: vi.fn(async () => ({ snapshotId: "template-1" })),
}));

afterEach(() => shutdownActiveSandboxHandles());

const alice = principal("alice");
const bob = principal("bob");
const gateway = principal("gateway", "service");

function principal(id: string, type = "user"): SessionAuthContext {
  return { attributes: {}, authenticator: "test", principalId: id, principalType: type };
}

// ---------------------------------------------------------------------------
// In-memory provider with named sandboxes and a non-atomic get-then-create.
// ---------------------------------------------------------------------------

interface StoredSandbox {
  lastUsedAt: number;
  readonly mock: MockSandbox;
  running: boolean;
  readonly tag: string;
}

function createNamedProvider(options: { readonly named?: boolean } = {}) {
  const store = new Map<string, StoredSandbox>();
  const events: string[] = [];
  let findBarrier: { count: number; release: () => void; wait: Promise<void> } | undefined;
  let now = 1_000;

  const handle = (name: string, stored: StoredSandbox): SandboxProviderHandle => ({
    sandbox: stored.mock.session,
    async onRuntimeShutdown() {},
    async onSessionDelete() {
      events.push(`delete:${name}`);
      store.delete(name);
    },
    async onSessionStop() {},
  });
  const started: string[] = [];

  const provider = defineSandboxProvider({
    name: "memory-named",
    environment: () => {
      const implementation: SandboxProviderImplementation<undefined, null, null> = {
        async prepare() {
          return null;
        },
        async resume() {
          throw new Error("tool sessions never resume from persisted state");
        },
        async start(context) {
          started.push(context.session.id);
          const stored: StoredSandbox = {
            lastUsedAt: now,
            mock: mockSandbox({ id: context.session.id }),
            running: true,
            tag: "",
          };
          return { handle: handle(`unnamed:${context.session.id}`, stored), state: null };
        },
      };
      const named: SandboxProviderNamedSessions<undefined, null> | undefined =
        options.named === false
          ? undefined
          : {
              async create(context, _options, _artifact, { name, tag }) {
                // The name check and insert are atomic; the caller's find before it is not.
                if (store.has(name)) {
                  events.push(`conflict:${name}`);
                  throw new SandboxNameConflictError(name);
                }
                const stored: StoredSandbox = {
                  lastUsedAt: now,
                  mock: mockSandbox({ id: context.session.id }),
                  running: true,
                  tag: `${tag.key}:${tag.value}`,
                };
                store.set(name, stored);
                events.push(`create:${name}`);
                return handle(name, stored);
              },
              async delete(_context, { name }) {
                store.delete(name);
              },
              async find(_context, _artifact, { name }) {
                events.push(`find:${name}`);
                const barrier = findBarrier;
                if (barrier !== undefined) {
                  barrier.count -= 1;
                  if (barrier.count === 0) barrier.release();
                  await barrier.wait;
                }
                const stored = store.get(name);
                if (stored === undefined) return null;
                const running = stored.running;
                stored.running = true;
                stored.lastUsedAt = now;
                return { handle: handle(name, stored), running };
              },
              async list(_context, tag) {
                return [...store.entries()]
                  .filter(([, stored]) => stored.tag === `${tag.key}:${tag.value}`)
                  .map(([name, stored]) => ({
                    lastUsedAt: stored.lastUsedAt,
                    name,
                    running: stored.running,
                  }));
              },
            };
      return named === undefined ? implementation : withNamedSandboxSessions(implementation, named);
    },
  });
  const environment = provider.environment();
  const registry: RuntimeSandboxRegistry = {
    sandbox: {
      definition: {
        environment,
        kind: "independent",
        logicalPath: "sandbox.ts",
        revisionHash: "hash",
        selector: defineSandbox(async () => await environment.open()),
        sourceId: "sandbox",
        sourceKind: "module",
      },
      workspaceResourceRoot: { logicalPath: "", rootEntries: [] },
    },
  };
  return {
    events,
    registry,
    started,
    store,
    /** Holds every `find` until `count` of them are in flight, once. */
    holdFinds(count: number) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      findBarrier = {
        count,
        release: () => {
          findBarrier = undefined;
          release();
        },
        wait,
      };
    },
    advance(ms: number) {
      now += ms;
    },
    /** Simulates the provider stopping idle sandboxes. */
    stopAll() {
      for (const stored of store.values()) stored.running = false;
    },
    get now() {
      return now;
    },
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const objectSchema = defineJsonSchema({
  additionalProperties: false,
  properties: { path: { type: "string" }, text: { type: "string" } },
  type: "object",
});

function tool(
  name: string,
  execute: (input: any, ctx: ToolContext) => unknown,
  extra: Partial<HarnessToolDefinition> = {},
): HarnessToolDefinition {
  return {
    description: name,
    execute: createToolExecuteWithAuth({ execute, scope: name }),
    inputSchema: objectSchema,
    name,
    ...extra,
  };
}

/** Tools the stand-in manifest records as framework-owned. */
const FRAMEWORK_TOOL_NAMES = new Set(["agent", "bash", "load_skill", "read_file", "web_search"]);

function runtimeWith(
  tools: readonly HarnessToolDefinition[],
  registry: RuntimeSandboxRegistry = createNamedProvider().registry,
): ToolSessionRuntime {
  // A stand-in compiled manifest; the parity test covers a real compiled registry.
  const manifest: ToolSessionManifest = {
    bindings: Object.fromEntries(
      tools.map((definition) => [
        `source:${definition.name}`,
        {
          owner: FRAMEWORK_TOOL_NAMES.has(definition.name)
            ? ({ feature: "eve:defaults", kind: "framework" } as const)
            : ({ kind: "application" } as const),
        },
      ]),
    ),
    tools: tools.map((definition) => ({
      // Only `handling` matters here, and both behavior shapes carry it.
      behavior: definition.behavior as CompiledToolBehavior | undefined,
      hasExecute: definition.execute !== undefined,
      name: definition.name,
      sourceId: `source:${definition.name}`,
    })),
  };
  return {
    callbackBaseUrl: "https://agent.example",
    compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    manifest,
    nodeId: "__root__",
    sandboxRegistry: registry,
    tools: new Map(tools.map((definition) => [definition.name, definition])),
  };
}

function call(
  runtime: ToolSessionRuntime,
  name: string,
  input: unknown,
  options: Partial<InvokeToolOptions> = {},
) {
  return invokeToolInSession(runtime, name, input, {
    auth: alice,
    key: "conversation-1",
    ...options,
  });
}

// ---------------------------------------------------------------------------

describe("invokeTool: context", () => {
  it("runs the tool with a stand-in turn, the caller, and the tool session id", async () => {
    const seen: ToolContext[] = [];
    const runtime = runtimeWith([
      tool("whoami", (_input, ctx) => {
        seen.push(ctx);
        return "ok";
      }),
    ]);

    const result = await call(runtime, "whoami", {}, { callId: "call-7" });

    expect(result).toEqual({
      modelOutput: { type: "text", value: "ok" },
      output: "ok",
      status: "completed",
    });
    const ctx = seen[0]!;
    expect(ctx.session.id).toMatch(/^ts_[0-9a-f]{64}$/);
    expect(ctx.session.turn).toEqual({ id: "call-7", sequence: 0 });
    expect(ctx.session.parent).toBeUndefined();
    expect(ctx.session.auth).toEqual({ current: alice, initiator: alice });
    expect(ctx.callId).toBe("call-7");
  });

  it("uses the asserted initiator when present", async () => {
    const seen: ToolContext[] = [];
    const runtime = runtimeWith([tool("whoami", (_input, ctx) => void seen.push(ctx))]);

    await call(runtime, "whoami", {}, { initiator: bob });

    expect(seen[0]!.session.auth).toEqual({ current: alice, initiator: bob });
  });

  it("derives a different session for another user or forwarder with the same key", async () => {
    const ids: string[] = [];
    const runtime = runtimeWith([tool("whoami", (_input, ctx) => void ids.push(ctx.session.id))]);

    await call(runtime, "whoami", {});
    await call(runtime, "whoami", {});
    await call(runtime, "whoami", {}, { auth: bob });
    await call(runtime, "whoami", {}, { forwarder: gateway });
    await call(runtime, "whoami", {}, { key: "conversation-2" });

    expect(ids[0]).toBe(ids[1]);
    expect(new Set(ids).size).toBe(4);
  });

  it("mints a fresh one-off session per call unless the nonce is passed back", async () => {
    const ids: string[] = [];
    const runtime = runtimeWith([tool("whoami", (_input, ctx) => void ids.push(ctx.session.id))]);

    await call(runtime, "whoami", {}, { key: undefined });
    await call(runtime, "whoami", {}, { key: undefined });
    await call(runtime, "whoami", {}, { key: undefined, oneOffNonce: "n1" });
    await call(runtime, "whoami", {}, { key: undefined, oneOffNonce: "n1" });

    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe(ids[3]);
  });

  it("refuses a key longer than 512 characters", async () => {
    const execute = vi.fn();
    const runtime = runtimeWith([tool("t", execute)]);

    expect(await call(runtime, "t", {}, { key: "k".repeat(513) })).toMatchObject({
      status: "invalid-input",
    });
    expect((await call(runtime, "t", {}, { key: "k".repeat(512) })).status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("validates input against the tool schema", async () => {
    const execute = vi.fn();
    const runtime = runtimeWith([tool("t", execute)]);

    const result = await call(runtime, "t", { path: 42 });

    expect(result.status).toBe("invalid-input");
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails clearly for missing and non-invocable tools", async () => {
    const runtime = runtimeWith([
      tool("load_skill", () => "x", { frameworkAction: "load-skill" }),
      tool("agent", () => "x", {
        behavior: {
          availability: [],
          handling: {
            kind: "dispatch",
            target: { kind: "subagent-call", nodeId: "n", subagentName: "s" },
          },
        },
      }),
      tool("web_search", () => "x"),
      tool("bash", () => "x"),
      tool("describe_later", () => "x", {
        behavior: { availability: [], handling: { kind: "provider-tool" } } as never,
      }),
      { description: "no execute", inputSchema: objectSchema, name: "plain" },
    ]);

    expect(await call(runtime, "nope", {})).toMatchObject({
      message: 'The agent has no tool named "nope".',
      status: "failed",
    });
    for (const name of ["load_skill", "agent", "web_search", "bash", "describe_later", "plain"]) {
      const result = await call(runtime, name, {});
      expect(result.status).toBe("failed");
      expect(result.status === "failed" && result.message).toContain(
        `Tool "${name}" cannot be invoked outside a conversation`,
      );
    }
  });

  it("returns the tool's own error as failed with an error id", async () => {
    const runtime = runtimeWith([
      tool("boom", () => {
        throw new Error("no such path: /tmp/x");
      }),
    ]);

    const result = await call(runtime, "boom", {});

    expect(result).toMatchObject({ message: "no such path: /tmp/x", status: "failed" });
    expect(result.status === "failed" && result.errorId).toBeTruthy();
  });

  it("gives defineState its initial value and refuses updates, naming the tool", async () => {
    const counter = defineState("tool-session-test.counter", () => ({ count: 3 }));
    const runtime = runtimeWith([
      tool("read", () => counter.get()),
      tool("write", () => counter.update((value) => ({ count: value.count + 1 }))),
    ]);

    expect(await call(runtime, "read", {})).toMatchObject({
      output: { count: 3 },
      status: "completed",
    });
    const result = await call(runtime, "write", {});
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.message).toContain(
      'Tool "write" cannot update state',
    );
  });

  it("runs two calls in the same session in parallel", async () => {
    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = runtimeWith([
      tool("slow", async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        if (inFlight === 2) release();
        await gate;
        inFlight -= 1;
        return "done";
      }),
    ]);

    const results = await Promise.all([call(runtime, "slow", {}), call(runtime, "slow", {})]);

    expect(peak).toBe(2);
    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
  });
});

describe("invokeTool: approval", () => {
  const approvalTool = (
    execute: () => unknown,
    approval: Approval = () => "user-approval",
  ): HarnessToolDefinition => tool("deploy", execute, { approval });

  it("returns approval-required and never executes without an answer, forged callId or not", async () => {
    const execute = vi.fn(() => "deployed");
    const runtime = runtimeWith([approvalTool(execute)]);

    const first = await call(runtime, "deploy", {});
    expect(first).toMatchObject({ status: "approval-required" });
    const forged = await call(runtime, "deploy", {}, { callId: "call-that-was-approved-before" });
    expect(forged).toEqual({
      callId: "call-that-was-approved-before",
      status: "approval-required",
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it("does not carry an approval over to the next call with the same callId", async () => {
    const execute = vi.fn(() => "deployed");
    const runtime = runtimeWith([approvalTool(execute)]);

    const approved = await call(
      runtime,
      "deploy",
      {},
      { approval: { approved: true }, callId: "c1" },
    );
    expect(approved.status).toBe("completed");
    const retry = await call(runtime, "deploy", {}, { callId: "c1" });
    expect(retry.status).toBe("approval-required");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("runs the response policy with the caller as responder, and a rejection is denied", async () => {
    const execute = vi.fn(() => "deployed");
    const response = vi.fn(({ response }: { response: { principal: SessionAuthContext } }) =>
      response.principal.principalId === "alice"
        ? ({ status: "allowed" } as const)
        : ({ reason: "Only alice may approve deploys.", status: "rejected" } as const),
    );
    const runtime = runtimeWith([
      approvalTool(execute, { request: () => "user-approval", response }),
    ]);

    const denied = await call(runtime, "deploy", {}, { approval: { approved: true }, auth: bob });
    expect(denied).toEqual({ reason: "Only alice may approve deploys.", status: "denied" });
    expect(execute).not.toHaveBeenCalled();

    const allowed = await call(runtime, "deploy", {}, { approval: { approved: true } });
    expect(allowed.status).toBe("completed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(response.mock.calls[1]![0]).toMatchObject({
      request: { principal: alice, toolName: "deploy" },
      response: { decision: "approve", principal: alice },
    });
  });

  it("denies when the person declines", async () => {
    const execute = vi.fn();
    const runtime = runtimeWith([approvalTool(execute)]);

    expect(await call(runtime, "deploy", {}, { approval: { approved: false } })).toMatchObject({
      status: "denied",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("honors request-policy denial and pass-through", async () => {
    const runtime = runtimeWith([
      tool("blocked", vi.fn(), { approval: () => ({ reason: "Read-only mode.", type: "denied" }) }),
      tool("free", () => "ran", { approval: () => "not-applicable" }),
    ]);

    expect(await call(runtime, "blocked", {}, { approval: { approved: true } })).toEqual({
      reason: "Read-only mode.",
      status: "denied",
    });
    expect((await call(runtime, "free", {})).status).toBe("completed");
  });
});

describe("invokeTool: sign-in", () => {
  function interactive(resume?: { verifier: string }): AuthorizationDefinition {
    return {
      async completeAuthorization() {
        return { token: "fresh" };
      },
      displayName: "Linear",
      async getToken() {
        throw new ConnectionAuthorizationRequiredError("linear");
      },
      principalType: "user",
      async startAuthorization() {
        return resume === undefined
          ? { challenge: { url: "https://idp.example/authorize" } }
          : { challenge: { url: "https://idp.example/authorize" }, resume };
      },
    };
  }

  it("returns authorization-required with the strategy's challenge", async () => {
    const runtime = runtimeWith([
      tool("issues", async (_input, ctx) => {
        await ctx.getToken(interactive(), { authKey: "linear" });
        return "never";
      }),
    ]);

    const result = await call(runtime, "issues", {}, { callId: "c-auth" });

    expect(result).toMatchObject({
      callId: "c-auth",
      challenges: [{ challenge: { url: "https://idp.example/authorize" } }],
      status: "authorization-required",
    });
  });

  it("fails a strategy that returns resume state, naming the connection", async () => {
    const runtime = runtimeWith([
      tool("issues", async (_input, ctx) => {
        await ctx.getToken(interactive({ verifier: "pkce" }), { authKey: "linear" });
        return "never";
      }),
    ]);

    const result = await call(runtime, "issues", {});

    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.message).toMatch(
      /^Connection "[^"]+" cannot sign in/,
    );
    expect(result.status === "failed" && result.message).toContain("resume");
  });
});

describe("invokeTool: sandbox", () => {
  const writeTool = tool("write", async (input: { path: string; text: string }, ctx) => {
    const sandbox = await ctx.getSandbox();
    await sandbox.writeTextFile({ content: input.text, path: input.path });
    return "written";
  });
  const readTool = tool("read", async (input: { path: string }, ctx) => {
    const sandbox = await ctx.getSandbox();
    return await sandbox.readTextFile({ path: input.path });
  });

  it("opens no sandbox when the tool never asks for one", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([tool("pure", () => "x")], provider.registry);

    const result = await call(runtime, "pure", {});

    expect(result.sandbox).toBeUndefined();
    expect(provider.events).toEqual([]);
  });

  it("creates, reuses, then resumes one sandbox with a file surviving", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool, readTool], provider.registry);

    const created = await call(runtime, "write", { path: "/workspace/notes.txt", text: "hello" });
    expect(created.sandbox?.state).toBe("created");
    expect(created.sandbox?.ms).toEqual(expect.any(Number));

    const reused = await call(runtime, "read", { path: "/workspace/notes.txt" });
    expect(reused).toMatchObject({ output: "hello", sandbox: { state: "reused" } });

    provider.stopAll();
    const resumed = await call(runtime, "read", { path: "/workspace/notes.txt" });
    expect(resumed).toMatchObject({ output: "hello", sandbox: { state: "resumed" } });

    expect(provider.store.size).toBe(1);
    const [entry] = [...provider.store.values()];
    expect(entry!.tag).toBe("eve:tool-session");
  });

  it("gives another user's same key its own sandbox", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool, readTool], provider.registry);

    await call(runtime, "write", { path: "/workspace/a.txt", text: "alice's" });
    const bobs = await call(runtime, "read", { path: "/workspace/a.txt" }, { auth: bob });

    expect(bobs).toMatchObject({ output: null, sandbox: { state: "created" } });
    expect(provider.store.size).toBe(2);
  });

  it("converges concurrent first calls on one sandbox through the conflict retry", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool], provider.registry);
    provider.holdFinds(2);

    const results = await Promise.all([
      call(runtime, "write", { path: "/workspace/a.txt", text: "one" }),
      call(runtime, "write", { path: "/workspace/b.txt", text: "two" }),
    ]);

    expect(results.map((result) => result.status)).toEqual(["completed", "completed"]);
    expect(results.map((result) => result.sandbox?.state).sort()).toEqual(["created", "reused"]);
    expect(provider.store.size).toBe(1);
    expect(provider.events.filter((event) => event.startsWith("conflict:"))).toHaveLength(1);
    const [entry] = [...provider.store.values()];
    expect([...entry!.mock.files.keys()].sort()).toEqual(["/workspace/a.txt", "/workspace/b.txt"]);
  });

  it("deletes a one-off sandbox when the call ends", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool], provider.registry);

    const result = await call(
      runtime,
      "write",
      { path: "/workspace/a.txt", text: "x" },
      { key: undefined },
    );

    expect(result).toMatchObject({ sandbox: { state: "created" }, status: "completed" });
    expect(provider.store.size).toBe(0);
  });

  it("deletes a one-off sandbox on approval-required and authorization-required too", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith(
      [
        tool(
          "guarded",
          async (_input, ctx) => {
            await ctx.getSandbox();
            return "x";
          },
          {
            // The policy opens the sandbox before deciding, so the call holds one to release.
            approval: async (ctx) => {
              await ctx.getSandbox();
              return "user-approval" as const;
            },
          },
        ),
        tool("signin", async (_input, ctx) => {
          await ctx.getSandbox();
          await ctx.getToken(
            {
              async completeAuthorization() {
                return { token: "t" };
              },
              async getToken() {
                throw new ConnectionAuthorizationRequiredError("linear");
              },
              principalType: "user",
              async startAuthorization() {
                return { challenge: { url: "https://idp.example/a" } };
              },
            },
            { authKey: "linear" },
          );
        }),
      ],
      provider.registry,
    );

    const approval = await call(runtime, "guarded", {}, { key: undefined });
    expect(approval).toMatchObject({
      oneOffNonce: expect.any(String),
      status: "approval-required",
    });
    expect(provider.store.size).toBe(0);

    const signin = await call(runtime, "signin", {}, { key: undefined });
    expect(signin).toMatchObject({
      oneOffNonce: expect.any(String),
      status: "authorization-required",
    });
    expect(provider.store.size).toBe(0);
  });

  it("keeps a keyed sandbox after the call", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith([writeTool], provider.registry);

    await call(runtime, "write", { path: "/workspace/a.txt", text: "x" });

    expect(provider.store.size).toBe(1);
  });

  it("falls back to a call-scoped sandbox when the provider has no named lookup", async () => {
    const provider = createNamedProvider({ named: false });
    const runtime = runtimeWith([writeTool], provider.registry);

    const result = await call(runtime, "write", { path: "/workspace/a.txt", text: "x" });

    expect(result.sandbox?.state).toBe("created");
    expect(provider.started).toHaveLength(1);
    expect(provider.events).toContain(`delete:unnamed:${provider.started[0]}`);
  });
});

describe("sweepToolSessionSandboxes", () => {
  it("deletes tagged sandboxes unused past the expiry and keeps the rest", async () => {
    const provider = createNamedProvider();
    const runtime = runtimeWith(
      [tool("open", async (_input, ctx) => void (await ctx.getSandbox()))],
      provider.registry,
    );

    await call(runtime, "open", {}, { key: "old" });
    provider.advance(TOOL_SESSION_SANDBOX_EXPIRY_MS + 1);
    await call(runtime, "open", {}, { key: "fresh" });
    provider.stopAll();

    const result = await sweepToolSessionSandboxes({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      now: provider.now,
      registry: provider.registry,
    });

    expect(result.deleted).toHaveLength(1);
    expect(result.failed).toEqual([]);
    expect(provider.store.size).toBe(1);
  });

  it("reports providers that cannot list by tag", async () => {
    const provider = createNamedProvider({ named: false });

    const result = await sweepToolSessionSandboxes({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      registry: provider.registry,
    });

    expect(result.skipped).toContain('"memory-named"');
  });
});
