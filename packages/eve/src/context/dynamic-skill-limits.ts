import { Buffer } from "node:buffer";

import type { NamedSkillDefinition, SkillFileContent } from "#shared/skill-definition.js";
import { stripSkillFrontmatter } from "#shared/skill-package.js";

export const MAX_DYNAMIC_SKILL_FILE_BYTES = 256 * 1024;
export const MAX_DYNAMIC_SKILL_FILES = 128;
export const MAX_DYNAMIC_SKILL_MANIFEST_BYTES = 1024 * 1024;

/** Checks raw payloads before normalization copies them or base64 expands them. */
export function getDynamicSkillPackageSize(skill: NamedSkillDefinition): number {
  assertDynamicSkillManifestSize(Buffer.byteLength(skill.name));
  assertDynamicSkillManifestSize(Buffer.byteLength(skill.description));
  const instructionBytes = fileSize(skill, "SKILL.md", skill.markdown);
  let bytes = Buffer.byteLength(
    JSON.stringify({
      description: skill.description,
      files: [],
      markdown: stripSkillFrontmatter(skill.markdown),
      name: skill.name,
    }),
  );
  assertDynamicSkillManifestSize(bytes);
  let fileCount = 0;

  const addFile = (relativePath: string, contentBytes: number) => {
    if (fileCount === MAX_DYNAMIC_SKILL_FILES) {
      throw new Error(
        `Dynamic skill "${skill.name}" exceeds the ${MAX_DYNAMIC_SKILL_FILES}-file limit, including SKILL.md. Reduce the number of supporting files.`,
      );
    }
    assertDynamicSkillManifestSize(Buffer.byteLength(relativePath));
    bytes +=
      Buffer.byteLength(JSON.stringify({ content: "", relativePath })) +
      4 * Math.ceil(contentBytes / 3) +
      (fileCount++ > 0 ? 1 : 0);
    assertDynamicSkillManifestSize(bytes);
  };

  addFile("SKILL.md", instructionBytes);
  for (const relativePath in skill.files) {
    if (Object.hasOwn(skill.files, relativePath)) {
      addFile(relativePath, fileSize(skill, relativePath, skill.files[relativePath]!));
    }
  }
  return bytes;
}

function fileSize(skill: NamedSkillDefinition, path: string, content: SkillFileContent): number {
  const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
  if (bytes > MAX_DYNAMIC_SKILL_FILE_BYTES) {
    throw new Error(
      `Dynamic skill "${skill.name}" file "${path}" is ${bytes} bytes; the limit is ${MAX_DYNAMIC_SKILL_FILE_BYTES} bytes (256 KiB). Reduce the file content.`,
    );
  }
  return bytes;
}

export function assertDynamicSkillManifestSize(bytes: number): void {
  if (bytes > MAX_DYNAMIC_SKILL_MANIFEST_BYTES) {
    throw new Error(
      "Dynamic skill packages exceed the 1048576-byte (1 MiB) durable manifest limit across all resolvers, including base64 files and instruction text. Return fewer or smaller skill packages.",
    );
  }
}
