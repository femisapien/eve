import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import nodePath from "node:path";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { isSkillEntryFileName, SKILL_ENTRY_FILE_NAME } from "#shared/skill-entry-file.js";

/** Largest skill file `readSkill` returns. */
export const MAX_SKILL_FILE_BYTES = 512 * 1024;

export type SkillReadErrorCode =
  | "invalid-path"
  | "too-large"
  | "unavailable"
  | "unknown-file"
  | "unknown-skill";

/** Thrown by `readSkill`. `code` lets a channel map the failure onto its own protocol. */
export class SkillReadError extends Error {
  readonly code: SkillReadErrorCode;

  constructor(code: SkillReadErrorCode, message: string) {
    super(message);
    this.name = "SkillReadError";
    this.code = code;
  }
}

/**
 * Lookup into the compiled skill files of one agent. Paths are `/`-separated
 * and relative to the skill root, e.g. `SKILL.md` or `references/api.md`.
 */
export interface SkillFileSource {
  /** Regular files of one skill, sorted. Empty when the skill has no materialized files. */
  listFiles(skill: string): Promise<readonly string[]>;
  fileSize(skill: string, path: string): Promise<number>;
  readFile(skill: string, path: string): Promise<Uint8Array>;
}

/** Nitro `serverAssets` base that holds the root agent's shipped skill files. */
export const SKILL_FILES_SERVER_ASSET_BASE = "eve-skills";

/** Nitro `serverAssets` base that holds {@link SKILL_FILES_INDEX_KEY}. */
export const SKILL_FILES_INDEX_SERVER_ASSET_BASE = "eve-skill-index";

/** Key of the skill file index inside {@link SKILL_FILES_INDEX_SERVER_ASSET_BASE}. */
export const SKILL_FILES_INDEX_KEY = "skills.json";

/**
 * One indexed file: `[path, size, storageKey, sha256]`. `path` is the real
 * `/`-separated path under the skill root. `storageKey` and `sha256` are
 * `null` for files over {@link MAX_SKILL_FILE_BYTES}, which are listed but
 * not shipped.
 */
export type SkillFilesIndexEntry = readonly [
  path: string,
  size: number,
  storageKey: string | null,
  sha256: string | null,
];

/**
 * Index of the skill files a production build ships, written by `eve build`.
 * eve owns the listing rather than deriving it from storage keys, so
 * `describe()` reports real paths and storage is used only to fetch bytes. Entries are arrays, not object keys,
 * so names such as `__proto__` stay plain data.
 */
export interface SkillFilesIndex {
  readonly version: 1;
  /** `[skill, entries]`, sorted by skill then path. */
  readonly skills: readonly (readonly [string, readonly SkillFilesIndexEntry[]])[];
}

/**
 * Storage key of a shipped skill file under {@link SKILL_FILES_SERVER_ASSET_BASE}:
 * its SHA-256 with a `.bin` name. `.bin` makes Nitro inline the file as a
 * `Uint8Array` whatever its real extension, and a hex name is left unchanged
 * by unstorage key normalization, so real paths never pass through it.
 */
export function skillFileStorageKey(sha256: string): string {
  return `${sha256}.bin`;
}

/** The subset of an unstorage `Storage` the server asset source reads with. */
export interface SkillFileStorage {
  getItemRaw(key: string): Promise<unknown>;
}

/** Opens a Nitro server asset storage, e.g. `useStorage("assets:eve-skills")`. */
export type OpenSkillFileStorage = (base: string) => Promise<SkillFileStorage>;

const openNitroStorage: OpenSkillFileStorage = async (base) => {
  const { useStorage } = await import("nitro/storage");
  return useStorage(`assets:${base}`);
};

/**
 * Selects the skill file source for the active compiled artifacts.
 *
 * Skill files are materialized under the node's workspace resource root by
 * `compiler/workspace-resources.ts` and stripped from the manifest. Disk
 * artifacts (dev) read that tree directly with
 * {@link createDiskSkillFileSource}, which keeps the symlink and containment
 * checks against a tree that can change while the server runs. Bundled
 * artifacts (production builds) read the Nitro server assets `eve build`
 * registers for the root agent, via {@link createServerAssetSkillFileSource}.
 */
export function createCompiledSkillFileSource(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
  readonly openStorage?: OpenSkillFileStorage;
}): SkillFileSource {
  if (input.compiledArtifactsSource.kind !== "disk") {
    return createServerAssetSkillFileSource(input.openStorage ?? openNitroStorage);
  }
  const { compileDirectoryPath } = resolveRuntimeCompilerArtifactPaths(
    input.compiledArtifactsSource.appRoot,
  );
  return createDiskSkillFileSource(
    `${compileDirectoryPath}/${input.workspaceResourceRoot.logicalPath}/skills`,
  );
}

interface IndexedSkillFile {
  readonly size: number;
  readonly storageKey: string | null;
  readonly sha256: string | null;
}

/**
 * Reads skill files from the Nitro server assets of a production build.
 *
 * Listing and sizes come from the eve index ({@link SkillFilesIndex}), so
 * only files the build vetted are visible and an over-limit file is rejected
 * by size without loading it. Storage only supplies bytes, by the key the
 * index recorded. Nitro inlines each file as its own lazily imported chunk
 * of bytes (see `skill-server-assets.ts`), so a read loads only that file.
 * The bytes must match the indexed size and SHA-256; anything else is
 * reported as `unavailable` rather than served altered.
 */
export function createServerAssetSkillFileSource(
  openStorage: OpenSkillFileStorage,
): SkillFileSource {
  let index: Promise<Map<string, Map<string, IndexedSkillFile>>> | undefined;
  const loadIndex = () => {
    index ??= openStorage(SKILL_FILES_INDEX_SERVER_ASSET_BASE)
      .then((storage) => storage.getItemRaw(SKILL_FILES_INDEX_KEY))
      .then(parseSkillFilesIndex);
    // A failed load is retried on the next call rather than cached.
    index.catch(() => {
      index = undefined;
    });
    return index;
  };
  const lookup = async (skill: string, path: string) => {
    const file = (await loadIndex()).get(skill)?.get(path);
    if (file === undefined) throw unknownFile(skill, path);
    return file;
  };
  return {
    async listFiles(skill) {
      return [...((await loadIndex()).get(skill)?.keys() ?? [])].sort(comparePaths);
    },
    async fileSize(skill, path) {
      return (await lookup(skill, path)).size;
    },
    async readFile(skill, path) {
      const file = await lookup(skill, path);
      if (file.storageKey === null || file.sha256 === null) {
        throw new SkillReadError(
          "too-large",
          `Skill "${skill}" file "${path}" is ${file.size} bytes, over the ${MAX_SKILL_FILE_BYTES}-byte limit.`,
        );
      }
      const storage = await openStorage(SKILL_FILES_SERVER_ASSET_BASE);
      const value = await storage.getItemRaw(file.storageKey);
      const bytes = value instanceof Uint8Array ? value : undefined;
      if (bytes === undefined) {
        throw new SkillReadError(
          "unavailable",
          `Skill "${skill}" file "${path}" is missing from the server assets of this build.`,
        );
      }
      if (
        bytes.byteLength !== file.size ||
        createHash("sha256").update(bytes).digest("hex") !== file.sha256
      ) {
        throw new SkillReadError(
          "unavailable",
          `Skill "${skill}" file "${path}" does not match its build index; this build did not ship it byte for byte.`,
        );
      }
      return bytes;
    },
  };
}

function parseSkillFilesIndex(raw: unknown): Map<string, Map<string, IndexedSkillFile>> {
  const text =
    typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : "";
  let parsed: unknown;
  try {
    parsed = text === "" ? undefined : JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isSkillFilesIndex(parsed)) {
    throw new SkillReadError(
      "unavailable",
      "Skill files are not available: this server was not built by `eve build`, so it carries no skill files.",
    );
  }
  return new Map(
    parsed.skills.map(([skill, files]) => [
      skill,
      new Map(
        files.map(([path, size, storageKey, sha256]) => [path, { size, storageKey, sha256 }]),
      ),
    ]),
  );
}

function isSkillFilesIndex(value: unknown): value is SkillFilesIndex {
  if (typeof value !== "object" || value === null) return false;
  const { skills, version } = value as { skills?: unknown; version?: unknown };
  return (
    version === 1 &&
    Array.isArray(skills) &&
    skills.every(
      (entry) =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        Array.isArray(entry[1]) &&
        entry[1].every(isSkillFilesIndexEntry),
    )
  );
}

function isSkillFilesIndexEntry(value: unknown): value is SkillFilesIndexEntry {
  if (!Array.isArray(value) || value.length !== 4) return false;
  const [path, size, storageKey, sha256] = value as unknown[];
  return (
    typeof path === "string" &&
    Number.isSafeInteger(size) &&
    ((typeof storageKey === "string" && typeof sha256 === "string") ||
      (storageKey === null && sha256 === null))
  );
}

/**
 * Whether `target` lies strictly inside `root`, using the platform's path
 * rules: `realpath` returns backslash-separated, drive-lettered paths on
 * Windows, so a `/`-prefix comparison would reject every legitimate read
 * there. A relative path that is empty (the root itself), climbs out with
 * `..`, or is absolute (another drive on Windows) is not contained.
 */
export function isStrictlyContainedPath(
  root: string,
  target: string,
  path: Pick<typeof nodePath, "isAbsolute" | "relative" | "sep"> = nodePath,
): boolean {
  const relative = path.relative(root, target);
  if (relative === "" || path.isAbsolute(relative)) return false;
  const [first] = relative.split(path.sep);
  return first !== "..";
}

/**
 * Reads skill files from a materialized `skills/<name>/` tree.
 *
 * Only regular files reached through real directories are served:
 *
 * - A skill root (`skills/<name>`) that is a symlink lists no files and
 *   cannot be read.
 * - Listing skips symlinks and does not descend into symlinked directories.
 * - Before opening, every path component under the skill root is checked with
 *   `lstat`: directories must be real directories and the leaf a regular file.
 * - The leaf is opened with `O_NOFOLLOW` where the platform defines it, the
 *   open handle must be a regular file, and the `realpath` of the target must
 *   stay under the `realpath` of the skill root.
 *
 * Boundary: these checks cover every symlink present in the tree when a read
 * starts. They are not atomic. A process that can write to the tree and
 * swaps a checked directory for a symlink between the checks and the open
 * could redirect one read; the containment check narrows that to the instant
 * between `realpath` and `open`. The tree is the app's own compile output,
 * so such a writer can already change what is served.
 */
export function createDiskSkillFileSource(skillsRoot: string): SkillFileSource {
  const openFile = async (skill: string, path: string) => {
    const skillRoot = `${skillsRoot}/${skill}`;
    if (!(await isRealDirectory(skillRoot))) {
      throw unknownFile(skill, path);
    }
    const segments = path.split("/");
    let current = skillRoot;
    for (const [index, segment] of segments.entries()) {
      current = `${current}/${segment}`;
      const stats = await lstatOrUndefined(current);
      const isLeaf = index === segments.length - 1;
      if (stats === undefined || (isLeaf ? !stats.isFile() : !stats.isDirectory())) {
        throw unknownFile(skill, path);
      }
    }
    const [realRoot, realTarget] = await Promise.all([realpath(skillRoot), realpath(current)]);
    if (!isStrictlyContainedPath(realRoot, realTarget)) {
      throw unknownFile(skill, path);
    }
    const handle = await open(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        throw unknownFile(skill, path);
      }
      return { handle, size: stats.size };
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  return {
    async listFiles(skill) {
      const skillRoot = `${skillsRoot}/${skill}`;
      if (!(await isRealDirectory(skillRoot))) return [];
      const files = await listRegularFiles(skillRoot, "");
      return files.sort(comparePaths);
    },
    async fileSize(skill, path) {
      const { handle, size } = await openFile(skill, path);
      await handle.close();
      return size;
    },
    async readFile(skill, path) {
      const { handle } = await openFile(skill, path);
      try {
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    },
  };
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  return (await lstatOrUndefined(path))?.isDirectory() === true;
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function unknownFile(skill: string, path: string): SkillReadError {
  return new SkillReadError("unknown-file", `Skill "${skill}" has no file "${path}".`);
}

/**
 * Reads one file of one compiled skill.
 *
 * With no `path`, reads the skill's entry markdown under whatever case variant
 * of `SKILL.md` it was authored with. An explicit top-level `SKILL.md` matches
 * the entry file case-insensitively too; every other path must match a listed
 * file exactly.
 *
 * Only files the source lists are readable. Text is returned as a string;
 * anything that is not valid UTF-8 or contains NUL bytes is returned as raw
 * bytes.
 */
export async function readSkillFile(input: {
  readonly path?: string;
  readonly skill: string;
  readonly skills: readonly string[];
  readonly source: SkillFileSource;
}): Promise<string | Uint8Array> {
  const requested = input.path ?? SKILL_ENTRY_FILE_NAME;
  assertRelativeSkillPath(requested);
  if (!input.skills.includes(input.skill)) {
    throw new SkillReadError("unknown-skill", `Unknown skill "${input.skill}".`);
  }
  const files = await input.source.listFiles(input.skill);
  const path =
    isSkillEntryFileName(requested) && !files.includes(requested)
      ? (files.find(isSkillEntryFileName) ?? requested)
      : requested;
  if (!files.includes(path)) {
    throw unknownFile(input.skill, path);
  }
  const size = await input.source.fileSize(input.skill, path);
  if (size > MAX_SKILL_FILE_BYTES) {
    throw tooLarge(input.skill, path, size);
  }
  const bytes = await input.source.readFile(input.skill, path);
  // The file can change between the size check and the read.
  if (bytes.byteLength > MAX_SKILL_FILE_BYTES) {
    throw tooLarge(input.skill, path, bytes.byteLength);
  }
  return decodeText(bytes) ?? bytes;
}

function assertRelativeSkillPath(path: string): void {
  if (path.length === 0) {
    throw new SkillReadError("invalid-path", "Skill file path must not be empty.");
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new SkillReadError(
      "invalid-path",
      `Skill file path "${path}" must be relative to the skill root.`,
    );
  }
  if (path.includes("\\") || path.includes("\0")) {
    throw new SkillReadError(
      "invalid-path",
      `Skill file path "${path}" must use "/" separators and contain no NUL bytes.`,
    );
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new SkillReadError(
      "invalid-path",
      `Skill file path "${path}" must not contain empty, ".", or ".." segments.`,
    );
  }
}

function tooLarge(skill: string, path: string, size: number): SkillReadError {
  return new SkillReadError(
    "too-large",
    `Skill "${skill}" file "${path}" is ${size} bytes, over the ${MAX_SKILL_FILE_BYTES}-byte limit.`,
  );
}

/** Decodes UTF-8 text without NUL bytes; returns `undefined` for anything else. */
function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function listRegularFiles(directory: string, prefix: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const logicalPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    // Dirent reports symlinks as neither files nor directories, so they are skipped.
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(`${directory}/${entry.name}`, logicalPath)));
    } else if (entry.isFile()) {
      files.push(logicalPath);
    }
  }
  return files;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
