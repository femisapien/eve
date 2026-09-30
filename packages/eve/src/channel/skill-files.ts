import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import nodePath from "node:path";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { isSkillEntryFileName, SKILL_ENTRY_FILE_NAME } from "#shared/skill-entry-file.js";

/** Largest skill file `readSkill` returns. */
export const MAX_SKILL_FILE_BYTES = 512 * 1024;

/** Largest total of skill file bytes a bundled deployment embeds. */
export const MAX_BUNDLED_SKILL_FILES_BYTES = 8 * 1024 * 1024;

/**
 * One skill file embedded in bundled compiled artifacts. `content` is absent
 * when the file is over {@link MAX_SKILL_FILE_BYTES} or did not fit in
 * {@link MAX_BUNDLED_SKILL_FILES_BYTES}; the file is still listed.
 */
export interface BundledSkillFile {
  readonly content?: string;
  readonly encoding?: "base64" | "utf8";
  readonly size: number;
}

/**
 * Skill files of the root agent as `[skill, [[path, file], …]]` entries.
 *
 * Entries rather than objects keyed by name, so a skill or file named
 * `__proto__` or `constructor` round-trips through the generated module and
 * never collides with `Object.prototype`.
 */
export type BundledSkillFiles = readonly (readonly [
  skill: string,
  files: readonly (readonly [path: string, file: BundledSkillFile])[],
])[];

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

/**
 * Selects the skill file source for the active compiled artifacts.
 *
 * Skill files are materialized under the node's workspace resource root by
 * `compiler/workspace-resources.ts` and stripped from the manifest. Disk
 * artifacts read that tree directly. Bundled artifacts carry a lazily loaded
 * copy of the root agent's skill files, written beside the bootstrap.
 */
export function createCompiledSkillFileSource(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): SkillFileSource {
  if (input.compiledArtifactsSource.kind !== "disk") {
    const load = readBundledCompiledArtifacts()?.skillFiles;
    return load === undefined ? unavailableSkillFileSource : createBundledSkillFileSource(load);
  }
  const { compileDirectoryPath } = resolveRuntimeCompilerArtifactPaths(
    input.compiledArtifactsSource.appRoot,
  );
  return createDiskSkillFileSource(
    `${compileDirectoryPath}/${input.workspaceResourceRoot.logicalPath}/skills`,
  );
}

/** Reads skill files embedded in bundled compiled artifacts. */
export function createBundledSkillFileSource(
  load: () => Promise<BundledSkillFiles>,
): SkillFileSource {
  let loaded: Promise<ReadonlyMap<string, ReadonlyMap<string, BundledSkillFile>>> | undefined;
  const skillFiles = async (skill: string) => {
    loaded ??= load().then(
      (entries) => new Map(entries.map(([name, files]) => [name, new Map(files)])),
    );
    return (await loaded).get(skill);
  };
  const file = async (skill: string, path: string) => {
    const entry = (await skillFiles(skill))?.get(path);
    if (entry === undefined) {
      throw new SkillReadError("unknown-file", `Skill "${skill}" has no file "${path}".`);
    }
    return entry;
  };
  return {
    async listFiles(skill) {
      return [...((await skillFiles(skill))?.keys() ?? [])].sort(comparePaths);
    },
    async fileSize(skill, path) {
      return (await file(skill, path)).size;
    },
    async readFile(skill, path) {
      const entry = await file(skill, path);
      if (entry.content === undefined) {
        throw new SkillReadError(
          "unavailable",
          `Skill "${skill}" file "${path}" is not embedded in this deployment: its skill files exceed the ${MAX_BUNDLED_SKILL_FILES_BYTES}-byte bundle limit.`,
        );
      }
      return entry.encoding === "base64"
        ? new Uint8Array(Buffer.from(entry.content, "base64"))
        : new TextEncoder().encode(entry.content);
    },
  };
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
 * starts. They are not atomic. A process that can write to the compile
 * directory and swaps a checked directory for a symlink between the checks
 * and the open could redirect one read; the containment check narrows that
 * to the instant between `realpath` and `open`. The compile directory is
 * build output owned by the app, so such a writer can already change what
 * is served.
 */
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

const unavailableSkillFileSource: SkillFileSource = {
  listFiles: rejectUnavailable,
  fileSize: rejectUnavailable,
  readFile: rejectUnavailable,
};

async function rejectUnavailable(): Promise<never> {
  throw new SkillReadError(
    "unavailable",
    "Skill files are not available: the installed compiled artifacts carry no skill files.",
  );
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
export function decodeText(bytes: Uint8Array): string | undefined {
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
