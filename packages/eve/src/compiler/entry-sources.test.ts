import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAgent } from "#public/definitions/create-agent.js";
import { defineTool, disableTool } from "#tools/definition.js";
import { defineInstructions, defineDynamic } from "#public/definitions/instructions.js";
import { defineChannel, disableRoute, GET } from "#public/definitions/channel.js";
import { createAgentSourceManifest, createModuleSourceRef } from "#discover/manifest.js";
import { prepareEntrySources } from "#compiler/entry-sources.js";
import { compileAgentManifest } from "#compiler/normalize-manifest.js";
import { compiledAgentManifestSchema } from "#compiler/manifest.js";
import { createProgrammaticCompiledModuleMap } from "#compiler/module-map.js";
import { frameworkAgentSourceRegistry } from "#framework/sources/registry.js";
import { projectEntryNamespace } from "#internal/entry-source.js";
import { defineSkill } from "#public/definitions/skill.js";

const authored = vi.hoisted(() => ({
  namespace: {} as Record<string, unknown>,
  files: new Map<string, Record<string, unknown>>(),
}));
vi.mock("#internal/authored-module-loader.js", () => ({
  loadAuthoredModuleNamespace: async (path: string) =>
    authored.files.get(path) ?? authored.namespace,
}));

const selection = { appRoot: "/virtual/app", entry: "src/support.ts", registration: "support" };
const tool = defineTool({
  description: "Return a greeting.",
  inputSchema: {},
  execute: () => "hello",
});
async function compile() {
  const prepared = await prepareEntrySources(selection);
  return compileAgentManifest(prepared.manifest, {
    entryCandidates: prepared.candidates,
    entryNamespaces: prepared.namespaces,
  });
}

beforeEach(() => {
  authored.namespace = {};
  authored.files.clear();
});

describe("explicit entry compilation", () => {
  it("preserves defaults, logical ordering, static roles and executable bindings", async () => {
    const resolve = vi.fn(() => defineInstructions({ content: "dynamic" }));
    authored.namespace = {
      default: createAgent({
        model: "openai/gpt-5.4",
        instructions: {
          welcome: defineInstructions({ content: "welcome", role: "user" }),
          context: defineDynamic({ events: { "turn.started": resolve } }),
        },
        tools: { zebra: tool, alpha: tool },
        channels: {
          health: defineChannel({ routes: [GET("/health", async () => new Response("ok"))] }),
        },
      }),
    };
    const compiled = await compile();
    expect(compiled.config.name).toBe("support");
    expect(
      compiled.tools.filter((item) => item.sourceId.startsWith("entry:")).map((item) => item.name),
    ).toEqual(["alpha", "zebra"]);
    expect(compiled.tools.some((item) => !item.sourceId.startsWith("entry:"))).toBe(true);
    expect(compiled.instructions).toEqual(
      expect.arrayContaining([expect.objectContaining({ content: "welcome", role: "user" })]),
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(compiled.dynamicInstructions).toEqual([
      expect.objectContaining({ logicalPath: "instructions/context.ts" }),
    ]);
    expect(
      compiled.channelRoutes.effective.some((item) => item.sourceId === "entry:channels/health.ts"),
    ).toBe(true);
    expect(compiledAgentManifestSchema.safeParse(compiled).success).toBe(true);
    const map = await createProgrammaticCompiledModuleMap(compiled, [frameworkAgentSourceRegistry]);
    expect(map.nodes.__root__?.modules["entry:tools/alpha.ts"]?.default).toBe(tool);
    expect(map.nodes.__root__?.modules["entry:instructions/welcome.ts"]).toBeUndefined();
  });

  it("uses string instructions and existing default-tool and disable policies", async () => {
    authored.namespace = {
      default: createAgent({
        model: "openai/gpt-5.4",
        defaultTools: false,
        instructions: "help Alice",
        tools: { hello: tool },
        channels: { eve: disableRoute() },
      }),
    };
    const compiled = await compile();
    expect(compiled.tools.map((item) => item.name)).toEqual(["hello"]);
    expect(compiled.instructions).toEqual([
      expect.objectContaining({ content: "help Alice", role: "system" }),
    ]);
    expect(
      compiled.channelRoutes.effective.some((route) => route.logicalPath === "channels/eve.ts"),
    ).toBe(false);
    authored.namespace = {
      default: createAgent({ model: "openai/gpt-5.4", tools: { bash: disableTool() } }),
    };
    const disabled = await compile();
    expect(disabled.tools.some((item) => item.name === "bash")).toBe(false);
  });

  it("matches filesystem configuration, skills, defaults and override semantics", async () => {
    const config = {
      model: "openai/gpt-5.4",
      limits: { maxInputTokensPerSession: 900 },
      tool: false,
    } as const;
    const instruction = defineInstructions({ content: "Help Bob", role: "user" });
    const skill = defineSkill({ description: "Greet Bob.", markdown: "Call the greeting tool." });
    authored.namespace = {
      default: createAgent({
        ...config,
        instructions: { base: instruction },
        tools: { bash: tool },
        skills: { greet: skill },
      }),
    };
    const entry = await compile();
    authored.files.set("/virtual/app/agent/agent.ts", { default: config });
    authored.files.set("/virtual/app/agent/instructions/base.ts", { default: instruction });
    authored.files.set("/virtual/app/agent/tools/bash.ts", { default: tool });
    authored.files.set("/virtual/app/agent/skills/greet.ts", { default: skill });
    const filesystem = await compileAgentManifest(
      createAgentSourceManifest({
        appRoot: selection.appRoot,
        agentRoot: "/virtual/app/agent",
        agentId: "support",
        configModule: createModuleSourceRef({ logicalPath: "agent.ts" }),
        instructions: [createModuleSourceRef({ logicalPath: "instructions/base.ts" })],
        tools: [createModuleSourceRef({ logicalPath: "tools/bash.ts" })],
        skills: [createModuleSourceRef({ logicalPath: "skills/greet.ts" })],
      }),
    );
    expect(entry.config).toEqual({ ...filesystem.config, source: entry.config.source });
    expect(entry.tools).toEqual(
      filesystem.tools.map((item) =>
        item.name === "bash" ? { ...item, sourceId: "entry:tools/bash.ts" } : item,
      ),
    );
    expect(entry.instructions).toEqual(
      filesystem.instructions.map((item) => ({ ...item, sourceId: "entry:instructions/base.ts" })),
    );
    expect(entry.skills).toEqual(
      filesystem.skills.map((item) => ({ ...item, sourceId: "entry:skills/greet.ts" })),
    );
    expect(entry.skills.map((item) => item.name)).toEqual(["greet"]);
    expect(entry.channelRoutes).toEqual(filesystem.channelRoutes);
  });

  it.each([
    ["tools", "nested/tool"],
    ["instructions", " bad"],
    ["channels", "UpperCase"],
  ])("rejects malformed %s keys with registration and entry context", async (category, key) => {
    authored.namespace = {
      default: {
        kind: "eve:agent",
        definition: { model: "openai/gpt-5.4", [category]: { [key]: tool } },
      },
    };
    await expect(compile()).rejects.toThrow(
      `Agent "support" entry "/virtual/app/src/support.ts" ${category} key`,
    );
  });

  it("fails closed for invalid exports, config and missing runtime members", async () => {
    authored.namespace = { default: { model: "openai/gpt-5.4" } };
    await expect(compile()).rejects.toThrow("must default-export a createAgent definition");
    authored.namespace = {
      default: { kind: "eve:agent", definition: { model: "openai/gpt-5.4", typo: true } },
    };
    await expect(compile()).rejects.toThrow("invalid configuration");
    const namespace = {
      default: createAgent({ model: "openai/gpt-5.4", tools: Object.create({ inherited: tool }) }),
    };
    expect(() =>
      projectEntryNamespace(
        namespace,
        { kind: "member", category: "tools", key: "inherited" },
        { registration: "support", sourcePath: "entry.ts" },
      ),
    ).toThrow('missing tools key "inherited"');
  });
});
