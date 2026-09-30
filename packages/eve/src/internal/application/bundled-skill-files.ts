import { Buffer } from "node:buffer";

import {
  type BundledSkillFile,
  type BundledSkillFiles,
  createDiskSkillFileSource,
  decodeText,
  MAX_BUNDLED_SKILL_FILES_BYTES,
  MAX_SKILL_FILE_BYTES,
} from "#channel/skill-files.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";

/**
 * Collects the root agent's materialized skill files for bundled artifacts.
 *
 * Every file is listed with its size. Content is embedded for files within
 * {@link MAX_SKILL_FILE_BYTES}, in skill-then-path order, until the total
 * reaches {@link MAX_BUNDLED_SKILL_FILES_BYTES}. Files past that budget stay
 * listed without content, and `omitted` names them so the build can warn;
 * reading one fails with an `unavailable` error instead of failing the build
 * of an app that never reads skills remotely.
 */
export async function collectBundledSkillFiles(input: {
  readonly compileDirectoryPath: string;
  readonly manifest: CompiledAgentManifest;
  /** Overrides {@link MAX_BUNDLED_SKILL_FILES_BYTES}; tests use it to exercise the budget. */
  readonly maxTotalBytes?: number;
}): Promise<{ readonly files: BundledSkillFiles; readonly omitted: readonly string[] }> {
  const source = createDiskSkillFileSource(
    `${input.compileDirectoryPath}/${input.manifest.workspaceResourceRoot.logicalPath}/skills`,
  );
  const files: Record<string, Record<string, BundledSkillFile>> = {};
  const omitted: string[] = [];
  const maxTotalBytes = input.maxTotalBytes ?? MAX_BUNDLED_SKILL_FILES_BYTES;
  let embeddedBytes = 0;
  const skillNames = input.manifest.skills.map((skill) => skill.name).sort();
  for (const skill of skillNames) {
    const entries: Record<string, BundledSkillFile> = {};
    for (const path of await source.listFiles(skill)) {
      const size = await source.fileSize(skill, path);
      if (size > MAX_SKILL_FILE_BYTES) {
        entries[path] = { size };
        continue;
      }
      if (embeddedBytes + size > maxTotalBytes) {
        entries[path] = { size };
        omitted.push(`${skill}/${path}`);
        continue;
      }
      embeddedBytes += size;
      const bytes = await source.readFile(skill, path);
      const text = decodeText(bytes);
      entries[path] =
        text === undefined
          ? { content: Buffer.from(bytes).toString("base64"), encoding: "base64", size }
          : { content: text, encoding: "utf8", size };
    }
    files[skill] = entries;
  }
  return { files, omitted };
}
