import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { materializeVercelWorkflowFunctionOutput } from "#internal/workflow-bundle/vercel-workflow-output.js";

describe("materializeVercelWorkflowFunctionOutput", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "eve-vercel-workflow-output-"));
  });

  afterEach(async () => {
    await rm(outputDir, { force: true, recursive: true });
  });

  it("copies the server function into the flow function without the skill files", async () => {
    const serverFunction = join(outputDir, "functions", "__server.func");
    const flowFunction = join(outputDir, "functions", ".well-known", "workflow", "v1", "flow.func");
    await mkdir(join(serverFunction, "_eve-skills", "research"), { recursive: true });
    await mkdir(flowFunction, { recursive: true });
    await writeFile(join(serverFunction, "index.mjs"), "export default {};\n");
    await writeFile(join(serverFunction, ".vc-config.json"), '{"handler":"index.mjs"}');
    await writeFile(join(serverFunction, "_eve-skills", "research", "SKILL.md"), "# Research\n");
    await writeFile(join(flowFunction, ".vc-config.json"), '{"handler":"index.mjs","flow":true}');

    await materializeVercelWorkflowFunctionOutput(outputDir);

    expect((await readdir(flowFunction)).sort()).toEqual([".vc-config.json", "index.mjs"]);
    await expect(readFile(join(flowFunction, ".vc-config.json"), "utf8")).resolves.toContain(
      '"flow":true',
    );
    await expect(
      readFile(join(serverFunction, "_eve-skills", "research", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Research\n");
  });
});
