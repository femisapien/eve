import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_SKILL_FILE_BYTES, skillFileStorageKey } from "#channel/skill-files.js";
import {
  prepareSkillServerAssets,
  SkillServerAssetKeyCollisionError,
} from "./skill-server-assets.js";

describe("prepareSkillServerAssets", () => {
  let root: string;
  let skillsRoot: string;
  let indexDirectory: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eve-skill-server-assets-"));
    skillsRoot = join(root, "skills");
    indexDirectory = join(root, "index");
    await mkdir(join(skillsRoot, "research", "references"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("indexes real paths with storage keys and digests, and ignores what does not ship", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    await writeFile(join(skillsRoot, "research", "SKILL.md"), "# Research\n");
    await writeFile(join(skillsRoot, "research", "references", "x.md"), "x\n");
    await writeFile(join(skillsRoot, "research", "logo.png"), png);
    await writeFile(
      join(skillsRoot, "research", "huge.bin"),
      Buffer.alloc(MAX_SKILL_FILE_BYTES + 1),
    );
    await writeFile(join(skillsRoot, "research", ".hidden"), "dot\n");
    await writeFile(join(skillsRoot, "research", "what?.md"), "q\n");
    await writeFile(join(root, "secret.txt"), "outside\n");
    await symlink(join(root, "secret.txt"), join(skillsRoot, "research", "linked.txt"));
    await symlink(join(root), join(skillsRoot, "research", "linked-dir"));
    await mkdir(join(skillsRoot, "unlisted"));
    await writeFile(join(skillsRoot, "unlisted", "SKILL.md"), "# Unlisted\n");

    const assets = await prepareSkillServerAssets({
      indexDirectory,
      skills: ["research"],
      skillsRoot,
    });

    const index = JSON.parse(await readFile(join(indexDirectory, "skills.json"), "utf8"));
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    expect(index).toEqual({
      version: 1,
      skills: [
        [
          "research",
          [
            ["SKILL.md", 11, "research:SKILL.md", digest(Buffer.from("# Research\n"))],
            ["huge.bin", MAX_SKILL_FILE_BYTES + 1, null, null],
            ["logo.png", png.byteLength, "research:logo.png", digest(png)],
            ["references/x.md", 2, "research:references:x.md", digest(Buffer.from("x\n"))],
          ],
        ],
      ],
    });
    expect(assets.unaddressable).toEqual(["research/what?.md"]);
    expect(assets.serverAssets).toEqual([
      { baseName: "eve-skill-index", dir: indexDirectory },
      {
        baseName: "eve-skills",
        dir: skillsRoot,
        ignore: expect.arrayContaining([
          "research/huge.bin",
          "research/.hidden",
          "research/what\\?.md",
          "unlisted/SKILL.md",
          "research/linked.txt",
          "research/linked-dir",
          "research/linked-dir/**",
        ]),
      },
    ]);
  });

  it("fails the build when two real paths normalize to the same storage key", async () => {
    await writeFile(join(skillsRoot, "research", "references:x.md"), "colon\n");
    await writeFile(join(skillsRoot, "research", "references", "x.md"), "nested\n");

    await expect(
      prepareSkillServerAssets({ indexDirectory, skills: ["research"], skillsRoot }),
    ).rejects.toThrow(
      new SkillServerAssetKeyCollisionError("research:references:x.md", [
        "research/references/x.md",
        "research/references:x.md",
      ]),
    );
  });

  it("registers only the index when the agent has no skills tree", async () => {
    await rm(skillsRoot, { force: true, recursive: true });

    const assets = await prepareSkillServerAssets({ indexDirectory, skills: [], skillsRoot });

    expect(assets.serverAssets).toEqual([{ baseName: "eve-skill-index", dir: indexDirectory }]);
    expect(JSON.parse(await readFile(join(indexDirectory, "skills.json"), "utf8"))).toEqual({
      version: 1,
      skills: [],
    });
  });
});

describe("skillFileStorageKey", () => {
  it("normalizes like unstorage", () => {
    expect(skillFileStorageKey("research", "references/deep/api.md")).toBe(
      "research:references:deep:api.md",
    );
    expect(skillFileStorageKey("research", "a::b")).toBe("research:a:b");
    expect(skillFileStorageKey("research", "a?b")).toBe("research:a");
    expect(skillFileStorageKey("Research", "SKILL.md")).toBe("Research:SKILL.md");
  });
});
