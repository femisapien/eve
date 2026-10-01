import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { useScenarioApp } from "#internal/testing/scenario-app.js";
import { buildApplication } from "./build-application.js";
import { startProductionServer } from "./start-production-server.js";

describe("skill files in production server output", () => {
  const scenarioApp = useScenarioApp();

  it("ships the skills tree as non-public server files that readSkill() serves", async () => {
    const { appRoot } = await scenarioApp({
      name: "server-output-skill-files",
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
          "  ],",
          "});",
        ].join("\n"),
      },
    });

    await buildApplication(appRoot, { skipSandboxPrewarm: true });
    const serverSkills = join(appRoot, ".output", "server", "_eve-skills");
    expect(
      (await readdir(serverSkills, { recursive: true, withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(serverSkills.length + 1))
        .sort(),
    ).toEqual(["lower/skill.MD", "research/SKILL.md", "research/references/deep/api.md"]);
    await expect(access(join(appRoot, ".output", "public", "_eve-skills"))).rejects.toMatchObject({
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
            files: ["SKILL.md", "references/deep/api.md"],
            name: "research",
          },
        ],
      });
      expect((await fetch(new URL("/_eve-skills/research/SKILL.md", server.url))).status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
