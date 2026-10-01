import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServerOutputSkillFilesPlugin } from "#internal/nitro/host/server-output-skill-files-plugin.js";

describe("createServerOutputSkillFilesPlugin", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "eve-server-output-skills-"));
    await mkdir(join(root, "skills", "research", "references"), { recursive: true });
    await mkdir(join(root, "skills", "lower"), { recursive: true });
    await mkdir(join(root, "skills", "unlisted"), { recursive: true });
    await writeFile(join(root, "skills", "research", "SKILL.md"), "# Research\n");
    await writeFile(join(root, "skills", "research", "references", "api.md"), "nested\n");
    await writeFile(join(root, "skills", "lower", "skill.MD"), "# Lower\n");
    await writeFile(join(root, "skills", "unlisted", "SKILL.md"), "# Unlisted\n");
    await writeFile(join(root, "secret.txt"), "outside\n");
    await symlink(join(root, "secret.txt"), join(root, "skills", "research", "linked.txt"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("emits the regular files of the listed skills as plain assets", async () => {
    const plugin = createServerOutputSkillFilesPlugin({
      skills: ["lower", "research"],
      skillsRoot: join(root, "skills"),
    });
    const emitted: Record<string, string> = {};

    await plugin.generateBundle.call({
      emitFile(file) {
        emitted[file.fileName] = new TextDecoder().decode(file.source);
        return file.fileName;
      },
    });

    expect(emitted).toEqual({
      "_eve-skills/lower/skill.MD": "# Lower\n",
      "_eve-skills/research/SKILL.md": "# Research\n",
      "_eve-skills/research/references/api.md": "nested\n",
    });
  });

  it("stamps each entry chunk with the tree's URL relative to itself", () => {
    const plugin = createServerOutputSkillFilesPlugin({ skills: [], skillsRoot: root });

    expect(plugin.renderChunk("run();", { fileName: "index.mjs", isEntry: true })?.code).toBe(
      'globalThis.__eveServerOutputSkillsUrl = new URL("./_eve-skills/", import.meta.url).href; run();',
    );
    expect(
      plugin.renderChunk("run();", { fileName: "nested/entry.mjs", isEntry: true })?.code,
    ).toContain('new URL("./../_eve-skills/", import.meta.url)');
    expect(plugin.renderChunk("run();", { fileName: "_chunks/a.mjs", isEntry: false })).toBeNull();
  });
});
