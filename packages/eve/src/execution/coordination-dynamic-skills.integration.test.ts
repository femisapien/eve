import { Buffer } from "node:buffer";

import { beforeEach, expect, it, vi } from "vitest";

import { ContextContainer } from "#context/container.js";
import { bindDynamicSkillSandbox, DynamicSkillSandboxKey } from "#context/dynamic-skill-sandbox.js";
import {
  AuthKey,
  DynamicSkillManifestKey,
  MaterializedDynamicSkillNamesKey,
  SessionIdKey,
} from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { prepareActionDispatch } from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { ensureSandboxAccess } from "#execution/sandbox/ensure.js";
import { mockSandbox } from "#internal/testing/mocks/mock-sandbox.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

vi.mock("#execution/sandbox/ensure.js", () => ({ ensureSandboxAccess: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

it.each([false, true])(
  "persists dynamic materialization ownership only when dispatch shares the sandbox (%s)",
  async (sharesSandbox) => {
    const sandbox = mockSandbox();
    vi.mocked(ensureSandboxAccess).mockResolvedValue(sandbox.access);
    const ctx = new ContextContainer();
    const turnAgent = { dynamicModel: true, system: "", tools: [] } as const;
    ctx.set(BundleKey, {
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
      graph: {
        root: {
          agent: { config: { name: "parent" }, connections: [] },
          nodeId: "__root__",
          sandboxRegistry: { sandbox: { definition: {} } },
        },
      },
      resolvedAgent: { config: { name: "parent" }, skills: [] },
      subagentRegistry: { subagentsByName: new Map() },
      turnAgent,
    } as never);
    ctx.set(ChannelKey, { kind: "test" });
    ctx.set(AuthKey, null);
    ctx.set(SessionIdKey, "parent");
    ctx.set(DynamicSkillManifestKey, {
      resolver: [
        {
          description: "Policy",
          files: [
            { content: Buffer.from("# Policy").toString("base64"), relativePath: "SKILL.md" },
          ],
          markdown: "# Policy",
          name: "policy",
        },
      ],
    });
    const initialContext = serializeContext(ctx);
    const sessionState = createDurableSessionState({
      session: {
        agent: turnAgent,
        compaction: { recentWindowSize: 5, threshold: 10_000 },
        continuationToken: "parent-token",
        history: [],
        sessionId: "parent",
      },
    });

    const prepared = await prepareActionDispatch({
      batch: {
        event: { sequence: 1, stepIndex: 0, turnId: "turn-1" },
        requests: [{ callId: "child-1" }],
      },
      ctx,
      durableSession: readDurableSession(sessionState),
      plan: () => [{ kind: "child" }],
      planSharesSandbox: () => sharesSandbox,
      serializedContext: initialContext,
    });

    expect(initialContext[MaterializedDynamicSkillNamesKey.name]).toBeUndefined();
    expect(prepared.serializedContext[MaterializedDynamicSkillNamesKey.name]).toEqual(
      sharesSandbox ? ["policy"] : undefined,
    );
    expect(sandbox.writes.length > 0).toBe(sharesSandbox);
    expect(ensureSandboxAccess).toHaveBeenCalledTimes(sharesSandbox ? 1 : 0);

    const packagePath = "/workspace/skills/policy/SKILL.md";
    const receiptPath = "/workspace/skills/.eve-dynamic-skills/policy";
    expect(sandbox.files.has(packagePath)).toBe(sharesSandbox);
    expect(sandbox.files.has(receiptPath)).toBe(sharesSandbox);
    const checkpoint = JSON.parse(JSON.stringify(prepared.serializedContext));
    // The compiled bundle and channel are stubs; replay the remaining durable context.
    delete checkpoint[BundleKey.name];
    delete checkpoint[ChannelKey.name];
    const resumedOwner = await deserializeContext(checkpoint);
    bindDynamicSkillSandbox(resumedOwner, sandbox.access);
    await resumedOwner.require(DynamicSkillSandboxKey).refresh({});

    expect(sandbox.files.has(packagePath)).toBe(false);
    expect(sandbox.files.has(receiptPath)).toBe(false);
  },
);
