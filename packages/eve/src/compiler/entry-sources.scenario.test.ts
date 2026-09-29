import { execFile } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { compileAgentInWorkspace } from "#compiler/compile-agent.js";
import { bundleAuthoredModuleMapForGeneration } from "#internal/authored-module-loader.js";
import { useScenarioApp } from "#internal/testing/scenario-app.js";

const execFileAsync = promisify(execFile);

describe("programmatic entry artifacts", () => {
  const scenarioApp = useScenarioApp();

  it("reconstructs executable definitions in a fresh process without the authored tree", async () => {
    const app = await scenarioApp({
      name: "entry-reconstruction",
      installDependencies: true,
      files: {
        "src/support.ts": `
          import { createAgent, defineDynamic } from "eve";
          import { defineSkill } from "eve/skills";
          import { defineTool } from "eve/tools";
          import * as instructions from "eve/instructions";
          import { eveChannel } from "eve/channels/eve";
          import { greeting } from "./greeting";
          export default createAgent({
            model: defineDynamic({ events: { "turn.started": () => "openai/gpt-5.4" } }), defaultTools: false,
            instructions: {
              base: instructions.defineInstructions({ content: "Help Alice.", role: "system" }),
              context: instructions.defineDynamic({ events: {
                "turn.started": () => instructions.defineInstructions({ content: greeting("Alice"), role: "user" })
              } })
            },
            tools: { greet: defineTool({ description: "Greet a person.", inputSchema: {}, execute: () => greeting("Bob") }) },
            skills: { greeting: defineSkill({ description: "Greet people.", markdown: "Call the greet tool." }) },
            channels: { eve: eveChannel({ auth: false }) }
          });
        `,
        "src/greeting.ts": "export const greeting = (name: string) => `Hello ${name}`;",
        "agent/agent.ts": 'throw new Error("Adjacent filesystem agent must not load");',
        "agent/tools/unselected.ts": 'throw new Error("Adjacent tool must not load");',
      },
    });
    const artifactLocations = {
      publishedRoot: join(app.appRoot, ".eve"),
      writeRoot: join(app.appRoot, ".eve"),
    };
    const compile = (entry: string) =>
      compileAgentInWorkspace({
        artifactLocations,
        startPath: app.appRoot,
        entrySelection: { appRoot: app.appRoot, entry, registration: "support" },
      });
    const first = await compile("src/support.ts");
    expect(first.manifest.config.name).toBe("support");
    expect(first.manifest.tools.map((tool) => tool.name)).toEqual(["greet"]);
    expect(first.manifest.skills).toEqual([
      expect.objectContaining({ name: "greeting", markdown: "Call the greet tool." }),
    ]);
    expect(first.manifest.instructions).toEqual([
      expect.objectContaining({ content: "Help Alice." }),
    ]);
    await rename(join(app.appRoot, "src/support.ts"), join(app.appRoot, "src/relocated.ts"));
    const relocated = await compile("src/relocated.ts");
    expect(relocated.manifest.config.name).toBe(first.manifest.config.name);
    expect(Object.keys(relocated.manifest.bindings)).toEqual(Object.keys(first.manifest.bindings));
    const moduleMapPath = join(app.appRoot, "worker-map.mjs");
    const bundle = await bundleAuthoredModuleMapForGeneration({
      appRoot: app.appRoot,
      manifest: relocated.manifest,
      moduleMapPath,
    });
    await writeFile(moduleMapPath, bundle.code);
    await rename(join(app.appRoot, "src"), join(app.appRoot, "unavailable-source"));
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const { default: map } = await import(${JSON.stringify(pathToFileURL(moduleMapPath).href)});
      const modules = map.nodes.__root__.modules;
      const greeting = await modules["entry:tools/greet.ts"].default.execute();
      const instructions = await modules["entry:instructions/context.ts"].default.events["turn.started"]();
      const model = await modules["entry:agent.ts"].default.model.events["turn.started"]();
      console.log(JSON.stringify({ model, greeting, content: instructions.content, role: instructions.role, staticAbsent: !("entry:instructions/base.ts" in modules), channel: typeof modules["entry:channels/eve.ts"].default }));
    `,
      ],
      { cwd: app.appRoot, timeout: 20_000 },
    );
    expect(JSON.parse(stdout.trim())).toEqual({
      model: "openai/gpt-5.4",
      greeting: "Hello Bob",
      content: "Hello Alice",
      role: "user",
      staticAbsent: true,
      channel: "object",
    });
  });
});
