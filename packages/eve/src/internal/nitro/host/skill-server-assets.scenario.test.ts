import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { buildApplication } from "./build-application.js";
import { startProductionServer } from "./start-production-server.js";

/** A 1x1 PNG; its bytes include NUL and non-UTF-8 sequences. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("skill files in production server assets", () => {
  const scenarioApp = useScenarioApp();

  it("bundles the skills tree as Nitro server assets that readSkill() serves byte for byte", async () => {
    const { appRoot } = await scenarioApp({
      name: "skill-server-assets",
      installDependencies: true,
      files: {
        "agent/agent.ts": 'export default { model: "openai/gpt-5.4" };',
        "agent/instructions.md": "You are a precise assistant.",
        "agent/skills/research/SKILL.md":
          "---\nname: research\ndescription: Research carefully.\n---\n\n# Research\n",
        "agent/skills/research/references/deep/api.md": "nested api\n",
        "agent/skills/lower/skill.MD":
          "---\nname: lower\ndescription: Lower-case entry.\n---\n\n# Lower\n",
        "agent/channels/probe.ts": [
          'import { defineChannel, GET } from "eve/channels";',
          "export default defineChannel({",
          "  routes: [",
          '    GET("/probe", async (_request, { describe, readSkill }) =>',
          "      Response.json({",
          "        skills: (await describe()).skills,",
          '        research: await readSkill("research"),',
          '        nested: await readSkill("research", "references/deep/api.md"),',
          '        lower: await readSkill("lower", "SKILL.md"),',
          "      }),",
          "    ),",
          '    GET("/logo", async (_request, { readSkill }) => {',
          '      const bytes = await readSkill("research", "assets/logo.png");',
          "      return new Response(bytes, {",
          '        headers: { "x-kind": typeof bytes === "string" ? "string" : "bytes" },',
          "      });",
          "    }),",
          "  ],",
          "});",
        ].join("\n"),
      },
    });
    await mkdir(join(appRoot, "agent/skills/research/assets"), { recursive: true });
    await writeFile(join(appRoot, "agent/skills/research/assets/logo.png"), PNG);

    await buildApplication(appRoot, { skipSandboxPrewarm: true });
    // The server function carries no plain copy of the tree: Nitro inlines
    // each file as a lazily imported chunk.
    const serverFiles = (
      await readdir(join(appRoot, ".output", "server"), { recursive: true })
    ).map(String);
    expect(serverFiles.filter((path) => /\.(png|md|MD)$/.test(path))).toEqual([]);
    expect(serverFiles).toEqual(expect.arrayContaining([join("_virtual", "logo.png.mjs")]));
    await expect(access(join(appRoot, ".output", "server", "_eve-skills"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const server = await startProductionServer(appRoot, { host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(new URL("/probe", server.url));
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        lower: "---\nname: lower\ndescription: Lower-case entry.\n---\n\n# Lower\n",
        nested: "nested api\n",
        research: "---\nname: research\ndescription: Research carefully.\n---\n\n# Research\n",
        skills: [
          { description: "Lower-case entry.", files: ["skill.MD"], name: "lower" },
          {
            description: "Research carefully.",
            files: ["SKILL.md", "assets/logo.png", "references/deep/api.md"],
            name: "research",
          },
        ],
      });
      const logo = await fetch(new URL("/logo", server.url));
      expect(logo.status).toBe(200);
      expect(logo.headers.get("x-kind")).toBe("bytes");
      expect(Buffer.from(await logo.arrayBuffer()).equals(PNG)).toBe(true);
    } finally {
      await server.close();
    }
  });
});
