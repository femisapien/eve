import { lstat, readdir, readFile } from "node:fs/promises";

import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { resolveRuntimeCompilerArtifactPaths } from "#runtime/loaders/artifact-paths.js";

/** File `readSkill` returns when the caller names no path. */
export const DEFAULT_SKILL_FILE = "SKILL.md";

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

/**
 * Selects the skill file source for the active compiled artifacts.
 *
 * Skill files are materialized under the node's workspace resource root by
 * `compiler/workspace-resources.ts` and stripped from the manifest. Bundled
 * deployments do not ship that tree beside the server bundle, so they cannot
 * list or read skill files yet.
 */
export function createCompiledSkillFileSource(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): SkillFileSource {
  if (input.compiledArtifactsSource.kind !== "disk") {
    return unavailableSkillFileSource;
  }
  const { compileDirectoryPath } = resolveRuntimeCompilerArtifactPaths(
    input.compiledArtifactsSource.appRoot,
  );
  return createDiskSkillFileSource(
    `${compileDirectoryPath}/${input.workspaceResourceRoot.logicalPath}/skills`,
  );
}

/** Reads skill files from a materialized `skills/<name>/` tree. */
export function createDiskSkillFileSource(skillsRoot: string): SkillFileSource {
  const filePath = (skill: string, path: string) => `${skillsRoot}/${skill}/${path}`;
  return {
    async listFiles(skill) {
      const files = await listRegularFiles(`${skillsRoot}/${skill}`, "");
      return files.sort(comparePaths);
    },
    async fileSize(skill, path) {
      return (await lstat(filePath(skill, path))).size;
    },
    async readFile(skill, path) {
      return new Uint8Array(await readFile(filePath(skill, path)));
    },
  };
}

const unavailableSkillFileSource: SkillFileSource = {
  listFiles: rejectUnavailable,
  fileSize: rejectUnavailable,
  readFile: rejectUnavailable,
};

async function rejectUnavailable(): Promise<never> {
  throw new SkillReadError(
    "unavailable",
    "Skill files are not available in bundled deployments: the compiled workspace resource tree is not shipped with the server bundle.",
  );
}

/**
 * Reads one file of one compiled skill.
 *
 * Only files the source lists are readable, so traversal and symlinks cannot
 * reach outside the skill even when a path passes validation. Text is
 * returned as a string; anything that is not valid UTF-8 or contains NUL
 * bytes is returned as raw bytes.
 */
export async function readSkillFile(input: {
  readonly path?: string;
  readonly skill: string;
  readonly skills: readonly string[];
  readonly source: SkillFileSource;
}): Promise<string | Uint8Array> {
  const path = input.path ?? DEFAULT_SKILL_FILE;
  assertRelativeSkillPath(path);
  if (!input.skills.includes(input.skill)) {
    throw new SkillReadError("unknown-skill", `Unknown skill "${input.skill}".`);
  }
  const files = await input.source.listFiles(input.skill);
  if (!files.includes(path)) {
    throw new SkillReadError("unknown-file", `Skill "${input.skill}" has no file "${path}".`);
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

function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function listRegularFiles(directory: string, prefix: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
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
