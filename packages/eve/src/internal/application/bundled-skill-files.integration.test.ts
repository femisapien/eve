import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createBundledSkillFileSource,
  MAX_SKILL_FILE_BYTES,
  readSkillFile,
} from "#channel/skill-files.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { collectBundledSkillFiles } from "#internal/application/bundled-skill-files.js";

function manifestWith(skills: readonly string[]): CompiledAgentManifest {
  const manifest: Pick<CompiledAgentManifest, "skills" | "workspaceResourceRoot"> = {
    skills: skills.map((name) => ({ description: `${name} skill.`, name })) as never,
    workspaceResourceRoot: { logicalPath: "workspace-resources/__root__", rootEntries: ["skills"] },
  };
  return manifest as CompiledAgentManifest;
}

describe("collectBundledSkillFiles", () => {
  let compileDirectoryPath: string;
  const skillRoot = (skill: string) =>
    join(compileDirectoryPath, "workspace-resources", "__root__", "skills", skill);

  beforeEach(async () => {
    compileDirectoryPath = await mkdtemp(join(tmpdir(), "eve-bundled-skill-files-"));
    await mkdir(join(skillRoot("research"), "references"), { recursive: true });
    await writeFile(join(skillRoot("research"), "SKILL.md"), "\uFEFF# Research\n");
    await writeFile(join(skillRoot("research"), "references", "api.md"), "nested\n");
    await writeFile(join(skillRoot("research"), "logo.bin"), new Uint8Array([0, 1, 255]));
    await writeFile(join(skillRoot("research"), "huge.txt"), "a".repeat(MAX_SKILL_FILE_BYTES + 1));
    await mkdir(skillRoot("zeta"), { recursive: true });
    await writeFile(join(skillRoot("zeta"), "SKILL.md"), "# Zeta\n");
  });

  afterEach(async () => {
    await rm(compileDirectoryPath, { force: true, recursive: true });
  });

  it("embeds text and binary files that round-trip through the bundled source", async () => {
    const { files, omitted } = await collectBundledSkillFiles({
      compileDirectoryPath,
      manifest: manifestWith(["research", "zeta"]),
    });
    expect(omitted).toEqual([]);
    expect(files.research?.["huge.txt"]).toEqual({ size: MAX_SKILL_FILE_BYTES + 1 });

    const source = createBundledSkillFileSource(async () => JSON.parse(JSON.stringify(files)));
    const read = (path?: string) =>
      readSkillFile({ path, skill: "research", skills: ["research", "zeta"], source });

    await expect(read()).resolves.toBe("\uFEFF# Research\n");
    await expect(read("references/api.md")).resolves.toBe("nested\n");
    expect([...((await read("logo.bin")) as Uint8Array)]).toEqual([0, 1, 255]);
    await expect(read("huge.txt")).rejects.toMatchObject({ code: "too-large" });
  });

  it("lists files past the total budget without content", async () => {
    const { files, omitted } = await collectBundledSkillFiles({
      compileDirectoryPath,
      manifest: manifestWith(["research", "zeta"]),
      maxTotalBytes: 20,
    });

    expect(omitted).toEqual(["research/references/api.md", "zeta/SKILL.md"]);
    expect(files.zeta).toEqual({ "SKILL.md": { size: 7 } });
    expect(files.research?.["SKILL.md"]?.content).toBe("\uFEFF# Research\n");
  });
});
