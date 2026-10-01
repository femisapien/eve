import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createDiskSkillFileSource,
  MAX_SKILL_FILE_BYTES,
  SKILL_FILES_INDEX_KEY,
  SKILL_FILES_INDEX_SERVER_ASSET_BASE,
  SKILL_FILES_SERVER_ASSET_BASE,
  skillFileStorageKey,
  type SkillFilesIndex,
  type SkillFilesIndexEntry,
} from "#channel/skill-files.js";

/** One Nitro `serverAssets` entry. */
export interface SkillServerAssetDirectory {
  readonly baseName: string;
  readonly dir: string;
}

/**
 * Stages the root agent's materialized `skills/` tree as Nitro server assets
 * for a production build, and returns the `serverAssets` entries to register.
 *
 * The listing and bytes come from {@link createDiskSkillFileSource}, the same
 * source dev reads, so both modes agree on which files exist and the disk
 * source's symlink and containment rules decide what is eligible.
 *
 * Nitro picks how to inline a server asset from its file name: text MIME
 * types become UTF-8 strings, which loses bytes that are not valid UTF-8,
 * unstorage then decodes any string starting with `base64:`, and an empty
 * string is dropped by Nitro's `r.default || r`. So each shipped file is
 * written to `<stagingDirectory>/files/<sha256>.bin`; `.bin` is
 * `application/octet-stream`, which Nitro always inlines as a `Uint8Array`.
 * The content-addressed name is also a valid storage key as is, so no real
 * path is subject to unstorage key normalization and two paths can never
 * share a key. Identical files share one asset.
 *
 * Real paths, sizes, storage keys, and SHA-256 digests go into an eve-owned
 * index (`<stagingDirectory>/index/skills.json`), registered as its own
 * server asset. Files over {@link MAX_SKILL_FILE_BYTES} are indexed with
 * their size only and not staged, so `readSkill` reports `too-large` without
 * loading them.
 */
export async function prepareSkillServerAssets(input: {
  /** Build-owned directory the staged assets and the index are written to. */
  readonly stagingDirectory: string;
  readonly skills: readonly string[];
  /** The materialized `skills/` directory of the root agent's workspace resources. */
  readonly skillsRoot: string;
}): Promise<SkillServerAssetDirectory[]> {
  const source = createDiskSkillFileSource(resolve(input.skillsRoot));
  const filesDirectory = join(input.stagingDirectory, "files");
  const indexDirectory = join(input.stagingDirectory, "index");
  await rm(input.stagingDirectory, { force: true, recursive: true });
  await mkdir(filesDirectory, { recursive: true });
  await mkdir(indexDirectory, { recursive: true });

  const index: [string, SkillFilesIndexEntry[]][] = [];
  for (const skill of [...new Set(input.skills)].sort(comparePaths)) {
    const files: SkillFilesIndexEntry[] = [];
    for (const path of await source.listFiles(skill)) {
      const size = await source.fileSize(skill, path);
      if (size > MAX_SKILL_FILE_BYTES) {
        files.push([path, size, null, null]);
        continue;
      }
      // Hash and stage the bytes that were read, not a second read of the path.
      const bytes = await source.readFile(skill, path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const storageKey = skillFileStorageKey(sha256);
      await writeFile(join(filesDirectory, storageKey), bytes);
      files.push([path, bytes.byteLength, storageKey, sha256]);
    }
    index.push([skill, files]);
  }

  const skillFilesIndex: SkillFilesIndex = { version: 1, skills: index };
  await writeFile(join(indexDirectory, SKILL_FILES_INDEX_KEY), JSON.stringify(skillFilesIndex));
  return [
    { baseName: SKILL_FILES_INDEX_SERVER_ASSET_BASE, dir: indexDirectory },
    { baseName: SKILL_FILES_SERVER_ASSET_BASE, dir: filesDirectory },
  ];
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
