import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
  assertDynamicSkillManifestSize,
  getDynamicSkillPackageSize,
  MAX_DYNAMIC_SKILL_FILE_BYTES,
  MAX_DYNAMIC_SKILL_FILES,
  MAX_DYNAMIC_SKILL_MANIFEST_BYTES,
} from "#context/dynamic-skill-limits.js";
import { normalizeSkillPackage, stripSkillFrontmatter } from "#shared/skill-package.js";

describe("dynamic skill payload limits", () => {
  it("counts exact serialized bytes, including base64, escaped metadata, and both markdown copies", () => {
    const definition = {
      description: 'Read Alice’s "café" notes.\n',
      files: { 'references/"notes".txt': "café\n", "assets/data.bin": new Uint8Array([0, 255]) },
      markdown: "---\ndescription: café\n---\nKeep Alice’s notes.\n",
      name: "notes",
    };
    const normalized = normalizeSkillPackage(definition);
    const durable = {
      description: normalized.description,
      files: normalized.files.map((file) => ({
        content: file.content.toString("base64"),
        relativePath: file.relativePath,
      })),
      markdown: stripSkillFrontmatter(normalized.markdown),
      name: normalized.name,
    };

    expect(getDynamicSkillPackageSize(definition)).toBe(Buffer.byteLength(JSON.stringify(durable)));
  });

  it("bounds UTF-8 instruction bytes and binary supporting files before conversion", () => {
    const skill = {
      description: "Policy",
      markdown: "é".repeat(MAX_DYNAMIC_SKILL_FILE_BYTES / 2),
      name: "policy",
    };
    expect(() => getDynamicSkillPackageSize(skill)).not.toThrow();
    expect(() => getDynamicSkillPackageSize({ ...skill, markdown: `${skill.markdown}a` })).toThrow(
      'file "SKILL.md" is 262145 bytes',
    );
    expect(() =>
      getDynamicSkillPackageSize({
        ...skill,
        markdown: "Policy",
        files: { "asset.bin": new Uint8Array(MAX_DYNAMIC_SKILL_FILE_BYTES + 1) },
      }),
    ).toThrow('file "asset.bin" is 262145 bytes');
  });

  it("includes SKILL.md in the 128-file package limit", () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_DYNAMIC_SKILL_FILES - 1 }, (_, index) => [`file-${index}`, ""]),
    );
    const skill = { description: "Policy", files, markdown: "Policy", name: "policy" };
    expect(() => getDynamicSkillPackageSize(skill)).not.toThrow();
    expect(() => getDynamicSkillPackageSize({ ...skill, files: { ...files, extra: "" } })).toThrow(
      "128-file limit, including SKILL.md",
    );
  });

  it("rejects individually valid files whose encoded package exceeds the manifest budget", () => {
    expect(() =>
      getDynamicSkillPackageSize({
        description: "Policy",
        files: {
          "first.bin": new Uint8Array(MAX_DYNAMIC_SKILL_FILE_BYTES),
          "second.bin": new Uint8Array(70 * 1024),
        },
        markdown: "a".repeat(MAX_DYNAMIC_SKILL_FILE_BYTES),
        name: "policy",
      }),
    ).toThrow("1 MiB");
  });

  it("counts escaped descriptions and file paths against the aggregate budget", () => {
    const skill = { description: "Policy", markdown: "Policy", name: "policy" };
    expect(() =>
      getDynamicSkillPackageSize({ ...skill, description: "\0".repeat(180 * 1024) }),
    ).toThrow("1 MiB");
    expect(() =>
      getDynamicSkillPackageSize({
        ...skill,
        files: Object.fromEntries(
          Array.from({ length: 6 }, (_, index) => [`${index}-${"a".repeat(200 * 1024)}`, ""]),
        ),
      }),
    ).toThrow("1 MiB");
  });

  it("accepts the exact manifest byte limit and rejects one additional byte", () => {
    expect(() => assertDynamicSkillManifestSize(MAX_DYNAMIC_SKILL_MANIFEST_BYTES)).not.toThrow();
    expect(() => assertDynamicSkillManifestSize(MAX_DYNAMIC_SKILL_MANIFEST_BYTES + 1)).toThrow(
      "across all resolvers",
    );
  });
});
