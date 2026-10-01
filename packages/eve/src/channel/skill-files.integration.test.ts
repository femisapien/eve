import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createCompiledSkillFileSource,
  createDiskSkillFileSource,
  readSkillFile,
  SERVER_OUTPUT_SKILLS_URL_GLOBAL,
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

  it("reads a case-variant entry file by default and by its canonical name", async () => {
    await mkdir(join(root, "skills", "lower"), { recursive: true });
    await writeFile(join(root, "skills", "lower", "skill.MD"), "# Lower\n");
    const source = createDiskSkillFileSource(join(root, "skills"));
    const read = (path?: string) =>
      readSkillFile({ path, skill: "lower", skills: ["lower"], source });

    await expect(source.listFiles("lower")).resolves.toEqual(["skill.MD"]);
    await expect(read()).resolves.toBe("# Lower\n");
    await expect(read("SKILL.md")).resolves.toBe("# Lower\n");
    await expect(read("skill.MD")).resolves.toBe("# Lower\n");
  });

  it("rejects a symlinked skill root", async () => {
    await symlink(join(root, "skills", "research"), join(root, "skills", "linked"));
    const source = createDiskSkillFileSource(join(root, "skills"));

    await expect(source.listFiles("linked")).resolves.toEqual([]);
    await expect(source.readFile("linked", "SKILL.md")).rejects.toMatchObject({
      code: "unknown-file",
    });
    await expect(source.fileSize("linked", "SKILL.md")).rejects.toMatchObject({
      code: "unknown-file",
    });
    await expect(
      readSkillFile({ skill: "linked", skills: ["linked"], source }),
    ).rejects.toMatchObject({ code: "unknown-file" });
  });

  it("rejects symlinked directories anywhere under the skill root", async () => {
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(join(root, "outside", "leak.md"), "leak\n");
    await symlink(join(root, "outside"), join(root, "skills", "research", "references", "linked"));
    const source = createDiskSkillFileSource(join(root, "skills"));

    await expect(source.listFiles("research")).resolves.toEqual([
      "SKILL.md",
      "references/deep/api.md",
    ]);
    // The source itself refuses, even when a caller skips the listing gate.
    await expect(source.readFile("research", "references/linked/leak.md")).rejects.toMatchObject({
      code: "unknown-file",
    });
    await expect(source.fileSize("research", "references/linked/leak.md")).rejects.toMatchObject({
      code: "unknown-file",
    });
    await expect(source.readFile("research", "linked.txt")).rejects.toMatchObject({
      code: "unknown-file",
    });
  });

  it("serves files when the skills root itself sits behind a symlinked ancestor", async () => {
    await symlink(join(root, "skills"), join(root, "skills-alias"));
    const source = createDiskSkillFileSource(join(root, "skills-alias"));

    await expect(source.readFile("research", "SKILL.md")).resolves.toEqual(
      new TextEncoder().encode("# Research\n"),
    );
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

  it("reads bundled deployments from the server output tree the entry chunk points at", async () => {
    const serverOutputSkills = join(root, "server", "_eve", "skills");
    await mkdir(join(serverOutputSkills, "research"), { recursive: true });
    await writeFile(join(serverOutputSkills, "research", "SKILL.md"), "# Bundled\n");
    const createBundledSource = () =>
      createCompiledSkillFileSource({
        compiledArtifactsSource: { kind: "bundled" },
        workspaceResourceRoot: { logicalPath: "workspace-resources/__root__", rootEntries: [] },
      });
    const global = globalThis as Record<string, unknown>;

    try {
      global[SERVER_OUTPUT_SKILLS_URL_GLOBAL] = pathToFileURL(`${serverOutputSkills}/`).href;
      await expect(
        readSkillFile({ skill: "research", skills: ["research"], source: createBundledSource() }),
      ).resolves.toBe("# Bundled\n");
    } finally {
      delete global[SERVER_OUTPUT_SKILLS_URL_GLOBAL];
    }
    // A server not built by `eve build` has no stamped tree.
    await expect(createBundledSource().listFiles("research")).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
