import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createDiskSkillFileSource,
  isShippableSkillFilePath,
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
  readonly ignore?: string[];
}

export interface SkillServerAssets {
  /** Entries for Nitro's `serverAssets` option. */
  readonly serverAssets: SkillServerAssetDirectory[];
  /** `<skill>/<path>` of files left out because Nitro cannot bundle or address them. */
  readonly unaddressable: readonly string[];
}

/** Thrown when two skill files would share one Nitro storage key. */
export class SkillServerAssetKeyCollisionError extends Error {
  constructor(key: string, paths: readonly string[]) {
    super(
      `Skill files ${paths.map((path) => `"${path}"`).join(" and ")} map to the same server asset key "${key}". Rename one of them; readSkill() could not tell them apart.`,
    );
    this.name = "SkillServerAssetKeyCollisionError";
  }
}

/**
 * Registers the root agent's materialized `skills/` tree as Nitro server
 * assets for a production build, and writes the eve-owned index of what
 * ships as a second server asset.
 *
 * The listing comes from {@link createDiskSkillFileSource}, the same source
 * dev reads, so both modes agree on which files exist and the disk source's
 * symlink and containment rules decide what is eligible. Nitro's glob
 * follows symlinks and reads every file under `dir`, so everything the
 * index does not ship goes into `ignore`:
 *
 * - files over {@link MAX_SKILL_FILE_BYTES}, which the index lists with
 *   their size only, so `readSkill` reports `too-large` without loading them;
 * - symlinks, special files, and directories of skills the manifest does not list;
 * - paths Nitro cannot import or address ({@link isShippableSkillFilePath}).
 *
 * Each shipped file's storage key, size, and SHA-256 go into the index. The
 * runtime fetches bytes by that key and checks them against the size and
 * digest. Two real paths that normalize to the same key fail the build.
 */
export async function prepareSkillServerAssets(input: {
  /** Directory the index is written to; registered as its own server asset. */
  readonly indexDirectory: string;
  readonly skills: readonly string[];
  /** The materialized `skills/` directory of the root agent's workspace resources. */
  readonly skillsRoot: string;
}): Promise<SkillServerAssets> {
  const skillsRoot = resolve(input.skillsRoot);
  const source = createDiskSkillFileSource(skillsRoot);
  const skills = [...new Set(input.skills)].sort(comparePaths);
  const index: [string, SkillFilesIndexEntry[]][] = [];
  const shipped = new Set<string>();
  const keys = new Map<string, string>();
  for (const skill of skills) {
    const files: SkillFilesIndexEntry[] = [];
    for (const path of await source.listFiles(skill)) {
      const size = await source.fileSize(skill, path);
      if (size > MAX_SKILL_FILE_BYTES) {
        files.push([path, size, null, null]);
        continue;
      }
      const relativePath = `${skill}/${path}`;
      const key = skillFileStorageKey(skill, path);
      const existing = keys.get(key);
      if (existing !== undefined) {
        throw new SkillServerAssetKeyCollisionError(key, [existing, relativePath]);
      }
      keys.set(key, relativePath);
      const bytes = await source.readFile(skill, path);
      files.push([path, bytes.byteLength, key, createHash("sha256").update(bytes).digest("hex")]);
      shipped.add(relativePath);
    }
    index.push([skill, files]);
  }

  const tree = await crawlTree(skillsRoot, "");
  const listedSkills = new Set(skills);
  const ignore: string[] = [];
  const unaddressable: string[] = [];
  for (const path of tree.files) {
    if (shipped.has(path)) continue;
    ignore.push(escapeGlob(path));
    const [skill] = path.split("/");
    if (
      skill !== undefined &&
      listedSkills.has(skill) &&
      !isShippableSkillFilePath(path) &&
      !path.split("/").some((segment) => segment.startsWith("."))
    ) {
      unaddressable.push(path);
    }
  }
  for (const path of tree.excluded) {
    ignore.push(escapeGlob(path), `${escapeGlob(path)}/**`);
  }

  await mkdir(input.indexDirectory, { recursive: true });
  const skillFilesIndex: SkillFilesIndex = { version: 1, skills: index };
  await writeFile(
    join(input.indexDirectory, SKILL_FILES_INDEX_KEY),
    JSON.stringify(skillFilesIndex),
  );

  const serverAssets: SkillServerAssetDirectory[] = [
    { baseName: SKILL_FILES_INDEX_SERVER_ASSET_BASE, dir: input.indexDirectory },
  ];
  if (tree.exists) {
    serverAssets.push({ baseName: SKILL_FILES_SERVER_ASSET_BASE, dir: skillsRoot, ignore });
  }
  return { serverAssets, unaddressable };
}

interface CrawledTree {
  readonly exists: boolean;
  /** Regular files reached through real directories. */
  readonly files: string[];
  /** Symlinks and special files; Nitro's glob would follow or read them. */
  readonly excluded: string[];
}

async function crawlTree(root: string, prefix: string): Promise<CrawledTree> {
  let entries;
  try {
    entries = await readdir(prefix === "" ? root : join(root, prefix), { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return { exists: false, files: [], excluded: [] };
    throw error;
  }
  const files: string[] = [];
  const excluded: string[] = [];
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = await crawlTree(root, path);
      files.push(...nested.files);
      excluded.push(...nested.excluded);
    } else if (entry.isFile()) {
      files.push(path);
    } else {
      excluded.push(path);
    }
  }
  return { exists: true, files, excluded };
}

/** Escapes a literal path for picomatch, which Nitro's glob uses for `ignore`. */
export function escapeGlob(path: string): string {
  return path.replace(/[\\*?[\]{}()!+@|^$,]/g, "\\$&");
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
