import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type BundledSkillFiles,
  createBundledSkillFileSource,
  MAX_SKILL_FILE_BYTES,
  readSkillFile,
} from "#channel/skill-files.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  collectBundledSkillFiles,
  serializeBundledSkillFilesModule,
} from "#internal/application/bundled-skill-files.js";

function manifestWith(skills: readonly string[]): CompiledAgentManifest {
  const manifest: Pick<CompiledAgentManifest, "skills" | "workspaceResourceRoot"> = {
    skills: skills.map((name) => ({ description: `${name} skill.`, name })) as never,
    workspaceResourceRoot: { logicalPath: "workspace-resources/__root__", rootEntries: ["skills"] },
  };
  return manifest as CompiledAgentManifest;
}

function fileOf(files: BundledSkillFiles, skill: string, path: string) {
  return files.find(([name]) => name === skill)?.[1].find(([name]) => name === path)?.[1];
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
    expect(fileOf(files, "research", "huge.txt")).toEqual({ size: MAX_SKILL_FILE_BYTES + 1 });

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
    expect(files.find(([skill]) => skill === "zeta")?.[1]).toEqual([["SKILL.md", { size: 7 }]]);
    expect(fileOf(files, "research", "SKILL.md")?.content).toBe("\uFEFF# Research\n");
  });

  it("round-trips prototype-colliding names through the generated module", async () => {
    await mkdir(join(skillRoot("constructor"), "__proto__"), { recursive: true });
    await writeFile(join(skillRoot("constructor"), "skill.MD"), "# Ctor\n");
    await writeFile(join(skillRoot("constructor"), "__proto__", "polluted.md"), "nested\n");
    await writeFile(join(skillRoot("constructor"), "__proto__.md"), "file\n");
    await writeFile(join(skillRoot("research"), "__proto__"), "proto\n");
    const { files } = await collectBundledSkillFiles({
      compileDirectoryPath,
      manifest: manifestWith(["constructor", "research"]),
    });
    const modulePath = join(compileDirectoryPath, "skill-files.mjs");
    await writeFile(modulePath, serializeBundledSkillFilesModule(files));

    const imported = (await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`)) as {
      default: BundledSkillFiles;
    };
    expect(imported.default).toEqual(files);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const source = createBundledSkillFileSource(async () => imported.default);
    const read = (path?: string) =>
      readSkillFile({ path, skill: "constructor", skills: ["constructor", "research"], source });
    await expect(source.listFiles("constructor")).resolves.toEqual([
      "__proto__.md",
      "__proto__/polluted.md",
      "skill.MD",
    ]);
    await expect(read()).resolves.toBe("# Ctor\n");
    await expect(read("SKILL.md")).resolves.toBe("# Ctor\n");
    await expect(read("__proto__/polluted.md")).resolves.toBe("nested\n");
    await expect(read("__proto__.md")).resolves.toBe("file\n");
    await expect(
      readSkillFile({ path: "__proto__", skill: "research", skills: ["research"], source }),
    ).resolves.toBe("proto\n");
  });
});
