import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createCompiledSkillFileSource,
  createDiskSkillFileSource,
  readSkillFile,
} from "#channel/skill-files.js";

describe("createDiskSkillFileSource", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eve-skill-files-"));
    await mkdir(join(root, "skills", "research", "references", "deep"), { recursive: true });
    await writeFile(join(root, "skills", "research", "SKILL.md"), "# Research\n");
    await writeFile(join(root, "skills", "research", "references", "deep", "api.md"), "nested\n");
    await writeFile(join(root, "secret.txt"), "outside\n");
    await symlink(join(root, "secret.txt"), join(root, "skills", "research", "linked.txt"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("lists regular files sorted and skips symlinks", async () => {
    const source = createDiskSkillFileSource(join(root, "skills"));

    await expect(source.listFiles("research")).resolves.toEqual([
      "SKILL.md",
      "references/deep/api.md",
    ]);
    await expect(source.listFiles("absent")).resolves.toEqual([]);
  });

  it("reads SKILL.md and nested files, never a symlink target", async () => {
    const source = createDiskSkillFileSource(join(root, "skills"));
    const read = (path?: string) =>
      readSkillFile({ path, skill: "research", skills: ["research"], source });

    await expect(read()).resolves.toBe("# Research\n");
    await expect(read("references/deep/api.md")).resolves.toBe("nested\n");
    await expect(read("linked.txt")).rejects.toMatchObject({ code: "unknown-file" });
  });

  it("resolves the compiled resource tree under the app's compile directory", async () => {
    const appRoot = join(root, "app");
    const skillRoot = join(appRoot, ".eve", "compile", "workspace-resources", "__root__", "skills");
    await mkdir(join(skillRoot, "research"), { recursive: true });
    await writeFile(join(skillRoot, "research", "SKILL.md"), "# Compiled\n");

    const source = createCompiledSkillFileSource({
      compiledArtifactsSource: { appRoot, kind: "disk" },
      workspaceResourceRoot: {
        logicalPath: "workspace-resources/__root__",
        rootEntries: ["skills"],
      },
    });

    await expect(source.listFiles("research")).resolves.toEqual(["SKILL.md"]);
  });

  it("reports bundled deployments as unavailable", async () => {
    const source = createCompiledSkillFileSource({
      compiledArtifactsSource: { kind: "bundled" },
      workspaceResourceRoot: { logicalPath: "workspace-resources/__root__", rootEntries: [] },
    });

    await expect(source.listFiles("research")).rejects.toMatchObject({ code: "unavailable" });
  });
});
