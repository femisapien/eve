import { describe, expect, it, vi } from "vitest";

import { buildCallbackContext } from "#context/build-callback-context.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  dispatchDynamicSkillEvent,
  PendingSkillAnnouncementKey,
} from "#context/dynamic-skill-lifecycle.js";
import { bindDynamicSkillSandbox } from "#context/dynamic-skill-sandbox.js";
import {
  DynamicSkillManifestKey,
  SandboxKey,
  SessionIdKey,
  SessionKey,
  StaticModelReferenceKey,
} from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { executeLoadSkill } from "#execution/tools/load-skill.js";
import {
  mockSandbox,
  type MockSandbox,
  type MockSandboxInput,
} from "#internal/testing/mocks/mock-sandbox.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { defineSkill } from "#public/definitions/skill.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedDynamicSkillResolver, ResolvedSkillDefinition } from "#runtime/types.js";
import type { SkillPackageDefinition } from "#shared/skill-definition.js";

const SKILL_ROOT = "/home/agent/.agents/skills";
const HOME_PROBE_COMMAND = `printf '%s\\n' "$HOME"`;

function createContext(
  input: {
    readonly acquisitionDelayMs?: number;
    readonly ctx?: ContextContainer;
    readonly initialFiles?: MockSandboxInput["initialFiles"];
    readonly skills?: readonly ResolvedSkillDefinition[];
  } = {},
) {
  const ctx = input.ctx ?? new ContextContainer();
  const sandbox: MockSandbox = mockSandbox({
    commands: {
      [HOME_PROBE_COMMAND]: { exitCode: 0, stderr: "", stdout: "/home/agent\n" },
    },
    initialFiles: input.initialFiles,
    run: ({ command }) => {
      const files = [...command.matchAll(/\[ -f '([^']+)' \]/gu)].map((match) => match[1]!);
      return {
        exitCode: 0,
        stderr: "",
        stdout: files.length > 0 && files.every((path) => sandbox.files.has(path)) ? "present" : "",
      };
    },
  });
  const get = vi.fn(async () => {
    if (input.acquisitionDelayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, input.acquisitionDelayMs));
    }
    return sandbox.session;
  });
  ctx.set(SessionIdKey, "dynamic-skills-session");
  ctx.set(StaticModelReferenceKey, { id: "openai/gpt-5.5" });
  ctx.setVirtualContext(SessionKey, {
    auth: { current: null, initiator: null },
    sessionId: "dynamic-skills-session",
    turn: { id: "turn-1", sequence: 1 },
  });
  ctx.setVirtualContext(BundleKey, {
    resolvedAgent: { skills: input.skills ?? [] },
  } as never);
  ctx.setVirtualContext(SandboxKey, bindDynamicSkillSandbox(ctx, { ...sandbox.access, get }));
  return { ctx, get, sandbox };
}

function resolver(
  slug: string,
  handler: () => SkillPackageDefinition | Record<string, SkillPackageDefinition> | null,
): ResolvedDynamicSkillResolver {
  return {
    eventNames: ["turn.started"],
    events: { "turn.started": handler },
    exportName: "default",
    logicalPath: `skills/${slug}.ts`,
    slug,
    sourceId: `skills/${slug}.ts`,
    sourceKind: "module",
  };
}

async function startTurn(
  ctx: ContextContainer,
  resolvers: readonly ResolvedDynamicSkillResolver[],
) {
  await dispatchDynamicSkillEvent({
    ctx,
    event: { type: "turn.started", data: {} } as UnstampedMessageStreamEvent,
    messages: [],
    resolvers,
  });
}

function load(ctx: ContextContainer, name: string) {
  return contextStorage.run(ctx, () => executeLoadSkill({ skill: name }));
}

function skillHandle(ctx: ContextContainer, name: string) {
  return contextStorage.run(ctx, () => buildCallbackContext().getSkill(name));
}

describe("lazy dynamic skill lifecycle", () => {
  it.each([null, {}])(
    "resolves an empty turn-start result (%j) without a sandbox",
    async (result) => {
      const { ctx, get, sandbox } = createContext();

      await startTurn(ctx, [resolver("tenant", () => result)]);

      expect(ctx.get(DynamicSkillManifestKey)).toEqual({});
      expect(ctx.get(PendingSkillAnnouncementKey)).toBe("Available skills: none");
      expect(get).not.toHaveBeenCalled();
      expect(sandbox.writes).toEqual([]);
      expect(sandbox.commandLog).toEqual([]);
    },
  );

  it("loads markdown and announces unused supporting files without paying sandbox acquisition delay", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, get, sandbox } = createContext({ acquisitionDelayMs: 10_000 });
      let turnStarted = false;
      const started = startTurn(ctx, [
        resolver("policy", () =>
          defineSkill({ description: "Tenant policy", markdown: "Follow policy." }),
        ),
        resolver("report", () =>
          defineSkill({
            description: "Generate a report",
            markdown: "Read the template when needed.",
            files: { "references/template.txt": "Report template" },
          }),
        ),
      ]).then(() => {
        turnStarted = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(turnStarted).toBe(true);
      await started;
      await expect(load(ctx, "policy")).resolves.toBe("Follow policy.");
      await expect(load(ctx, "report")).resolves.toBe("Read the template when needed.");
      expect(ctx.get(PendingSkillAnnouncementKey)).toContain("report: Generate a report");
      expect(get).not.toHaveBeenCalled();
      expect(sandbox.writes).toEqual([]);
      expect(sandbox.commandLog).toEqual([]);

      let fileRead = false;
      const file = skillHandle(ctx, "report")
        .file("references/template.txt")
        .text()
        .then((text) => {
          fileRead = true;
          return text;
        });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fileRead).toBe(false);
      expect(get).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await expect(file).resolves.toBe("Report template");
      expect(sandbox.files.get(`${SKILL_ROOT}/report/SKILL.md`)).toBe(
        "Read the template when needed.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebuilds announcements and loads durable markdown after a JSON round trip before opening a fresh sandbox", async () => {
    const first = createContext();
    const bytes = new Uint8Array([0, 128, 255]);
    const body = "---\nKeep this body intact.\n---\nFollow the tenant policy.";
    const markdown = `---\ndescription: Tenant policy\n---\n${body}`;
    await startTurn(first.ctx, [
      resolver("tenant", () =>
        defineSkill({
          description: "Tenant policy",
          markdown,
          files: { "assets/policy.bin": bytes },
        }),
      ),
    ]);

    const durable = JSON.parse(JSON.stringify(serializeContext(first.ctx)));
    const resumed = createContext({ ctx: await deserializeContext(durable) });
    await startTurn(resumed.ctx, []);

    expect(resumed.ctx.get(PendingSkillAnnouncementKey)).toContain("tenant: Tenant policy");
    await expect(load(first.ctx, "tenant")).resolves.toBe(body);
    await expect(load(resumed.ctx, "tenant")).resolves.toBe(body);
    expect(first.get).not.toHaveBeenCalled();
    expect(resumed.get).not.toHaveBeenCalled();
    expect(resumed.sandbox.writes).toEqual([]);

    const actual = await skillHandle(resumed.ctx, "tenant").file("assets/policy.bin").bytes();
    expect([...actual]).toEqual([...bytes]);
    expect(resumed.get).toHaveBeenCalledOnce();
    expect(resumed.sandbox.files.get(`${SKILL_ROOT}/tenant/SKILL.md`)).toBe(markdown);
  });

  it("does not acquire or rewrite an unchanged package when fresh bytes and file key order change", async () => {
    const { ctx, get, sandbox } = createContext();
    let reversed = false;
    const dynamic = resolver("policy", () =>
      defineSkill({
        description: "Tenant policy",
        markdown: "Follow policy.",
        files: reversed
          ? { "references/b.txt": "second", "assets/a.bin": new Uint8Array([1, 2, 3]) }
          : { "assets/a.bin": new Uint8Array([1, 2, 3]), "references/b.txt": "second" },
      }),
    );
    await startTurn(ctx, [dynamic]);
    await skillHandle(ctx, "policy").file("assets/a.bin").bytes();
    const writes = sandbox.writes.length;
    const removals = sandbox.removedPaths.length;
    const commands = sandbox.commandLog.length;
    get.mockClear();

    reversed = true;
    await startTurn(ctx, [dynamic]);

    expect(get).not.toHaveBeenCalled();
    expect(sandbox.writes).toHaveLength(writes);
    expect(sandbox.removedPaths).toHaveLength(removals);
    expect(sandbox.commandLog).toHaveLength(commands);
  });

  it("refreshes changed packages and removes withdrawn packages while preserving unrelated files", async () => {
    const unrelated = `${SKILL_ROOT}/unrelated/notes.txt`;
    const { ctx, sandbox } = createContext({ initialFiles: { [unrelated]: "Keep this file." } });
    let revision = 1;
    let enabled = true;
    const tenant = resolver("tenant", () =>
      enabled
        ? defineSkill({
            description: "Tenant policy",
            markdown: `Policy revision ${revision}.`,
            files:
              revision === 1
                ? { "references/obsolete.txt": "old" }
                : { "references/current.txt": "new" },
          })
        : null,
    );
    const stable = resolver("stable", () =>
      defineSkill({
        description: "Stable policy",
        markdown: "Stable policy.",
        files: { "references/keep.txt": "Keep this too." },
      }),
    );
    await startTurn(ctx, [tenant, stable]);
    await skillHandle(ctx, "tenant").file("references/obsolete.txt").text();
    const writes = sandbox.writes.length;

    revision = 2;
    await startTurn(ctx, [tenant, stable]);

    expect(sandbox.files.has(`${SKILL_ROOT}/tenant/references/obsolete.txt`)).toBe(false);
    expect(sandbox.files.get(`${SKILL_ROOT}/tenant/references/current.txt`)).toBe("new");
    const changedWrites = sandbox.writes.slice(writes);
    expect(
      changedWrites
        .filter((write) => !write.path.startsWith(`${SKILL_ROOT}/.eve-dynamic-skills/`))
        .map((write) => write.path),
    ).toEqual([`${SKILL_ROOT}/tenant/SKILL.md`, `${SKILL_ROOT}/tenant/references/current.txt`]);
    expect(changedWrites.at(-1)?.path).toBe(`${SKILL_ROOT}/.eve-dynamic-skills/tenant`);
    await expect(load(ctx, "tenant")).resolves.toBe("Policy revision 2.");

    enabled = false;
    await startTurn(ctx, [tenant]);

    await expect(load(ctx, "tenant")).rejects.toThrow('No skill named "tenant".');
    expect([...sandbox.files.keys()].some((path) => path.startsWith(`${SKILL_ROOT}/tenant/`))).toBe(
      false,
    );
    expect(sandbox.files.get(`${SKILL_ROOT}/stable/references/keep.txt`)).toBe("Keep this too.");
    expect(sandbox.files.get(unrelated)).toBe("Keep this file.");
    expect(ctx.get(PendingSkillAnnouncementKey)).toContain("stable: Stable policy");
    expect(ctx.get(PendingSkillAnnouncementKey)).not.toContain("tenant: Tenant policy");
  });

  it("does not publish a replacement manifest or announcement when a materialized package refresh fails", async () => {
    const { ctx, sandbox } = createContext();
    let markdown = "Original policy.";
    const dynamic = resolver("tenant", () => defineSkill({ description: markdown, markdown }));
    await startTurn(ctx, [dynamic]);
    await skillHandle(ctx, "tenant").file("SKILL.md").text();
    const manifest = ctx.get(DynamicSkillManifestKey);
    const announcement = ctx.get(PendingSkillAnnouncementKey);
    vi.spyOn(sandbox.session, "writeBinaryFile").mockRejectedValueOnce(
      new Error("Sandbox write failed"),
    );

    markdown = "Replacement policy.";
    await expect(startTurn(ctx, [dynamic])).rejects.toThrow("Sandbox write failed");

    expect(ctx.get(DynamicSkillManifestKey)).toBe(manifest);
    expect(ctx.get(PendingSkillAnnouncementKey)).toBe(announcement);
    await expect(load(ctx, "tenant")).resolves.toBe("Original policy.");
  });

  it("loads a dynamic override and falls back to the authored skill after withdrawal without opening a sandbox", async () => {
    const { ctx, get, sandbox } = createContext({
      skills: [
        {
          description: "Static policy",
          logicalPath: "skills/policy.md",
          markdown: "Static policy.",
          name: "policy",
          sourceId: "skills/policy.md",
          sourceKind: "markdown",
        },
      ],
    });
    let enabled = true;
    const dynamic = resolver("policy", () =>
      enabled ? defineSkill({ description: "Dynamic policy", markdown: "Dynamic policy." }) : null,
    );
    await startTurn(ctx, [dynamic]);
    await expect(load(ctx, "policy")).resolves.toBe("Dynamic policy.");

    enabled = false;
    await startTurn(ctx, [dynamic]);

    await expect(load(ctx, "policy")).resolves.toBe("Static policy.");
    expect(get).not.toHaveBeenCalled();
    expect(sandbox.writes).toEqual([]);
    expect(sandbox.removedPaths).toEqual([]);
  });
});
