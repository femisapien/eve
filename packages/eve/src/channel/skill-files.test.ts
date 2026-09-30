import { describe, expect, it } from "vitest";

import {
  createBundledSkillFileSource,
  MAX_SKILL_FILE_BYTES,
  readSkillFile,
  SkillReadError,
  type SkillFileSource,
} from "#channel/skill-files.js";

function memorySource(
  tree: Readonly<Record<string, Readonly<Record<string, Uint8Array | string>>>>,
  options: { readonly reportedSize?: number } = {},
): SkillFileSource {
  const bytes = (skill: string, path: string) => {
    const content = tree[skill]?.[path];
    if (content === undefined) throw new Error(`missing ${skill}/${path}`);
    return typeof content === "string" ? new TextEncoder().encode(content) : content;
  };
  return {
    async listFiles(skill) {
      return Object.keys(tree[skill] ?? {}).sort();
    },
    async fileSize(skill, path) {
      return options.reportedSize ?? bytes(skill, path).byteLength;
    },
    async readFile(skill, path) {
      return bytes(skill, path);
    },
  };
}

const source = memorySource({
  research: {
    "SKILL.md": "# Research\n",
    "references/deep/api.md": "nested\n",
    "assets/logo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]),
  },
});
const skills = ["research"];

async function readError(promise: Promise<unknown>): Promise<SkillReadError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SkillReadError);
  return error as SkillReadError;
}

describe("readSkillFile", () => {
  it("reads SKILL.md by default", async () => {
    await expect(readSkillFile({ skill: "research", skills, source })).resolves.toBe(
      "# Research\n",
    );
  });

  it("reads a nested file", async () => {
    await expect(
      readSkillFile({ path: "references/deep/api.md", skill: "research", skills, source }),
    ).resolves.toBe("nested\n");
  });

  it("returns bytes for files that are not UTF-8 text", async () => {
    const content = await readSkillFile({
      path: "assets/logo.png",
      skill: "research",
      skills,
      source,
    });
    expect(content).toBeInstanceOf(Uint8Array);
    expect([...(content as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  });

  it.each([
    "../other/SKILL.md",
    "references/../../secret",
    "references/..",
    "./SKILL.md",
    "/etc/passwd",
    "C:/Windows/win.ini",
    "references\\api.md",
    "references//api.md",
    "",
  ])("rejects the path %j", async (path) => {
    const error = await readError(readSkillFile({ path, skill: "research", skills, source }));
    expect(error.code).toBe("invalid-path");
  });

  it("rejects unknown skills and files", async () => {
    expect((await readError(readSkillFile({ skill: "missing", skills, source }))).message).toBe(
      'Unknown skill "missing".',
    );
    expect(
      (await readError(readSkillFile({ path: "nope.md", skill: "research", skills, source })))
        .message,
    ).toBe('Skill "research" has no file "nope.md".');
  });

  it("rejects skills the source has files for but the manifest does not list", async () => {
    const error = await readError(readSkillFile({ skill: "research", skills: [], source }));
    expect(error.code).toBe("unknown-skill");
  });

  it("enforces the 512 KiB cap", async () => {
    const atCap = memorySource({ big: { "SKILL.md": "a".repeat(MAX_SKILL_FILE_BYTES) } });
    await expect(
      readSkillFile({ skill: "big", skills: ["big"], source: atCap }),
    ).resolves.toHaveLength(MAX_SKILL_FILE_BYTES);

    const overCap = memorySource({ big: { "SKILL.md": "a".repeat(MAX_SKILL_FILE_BYTES + 1) } });
    const error = await readError(
      readSkillFile({ skill: "big", skills: ["big"], source: overCap }),
    );
    expect(error.code).toBe("too-large");
    expect(error.message).toContain("524288-byte limit");
  });

  it("enforces the cap when the file grows after the size check", async () => {
    const grown = memorySource(
      { big: { "SKILL.md": "a".repeat(MAX_SKILL_FILE_BYTES + 1) } },
      { reportedSize: 1 },
    );
    const error = await readError(readSkillFile({ skill: "big", skills: ["big"], source: grown }));
    expect(error.code).toBe("too-large");
  });
});

describe("createBundledSkillFileSource", () => {
  const bundled = createBundledSkillFileSource(async () => ({
    research: {
      "SKILL.md": { content: "# Research\n", encoding: "utf8", size: 11 },
      "assets/logo.png": { content: "iVBORwD/", encoding: "base64", size: 6 },
      "data/huge.csv": { size: MAX_SKILL_FILE_BYTES + 1 },
      "references/omitted.md": { size: 10 },
      "references/deep/api.md": { content: "nested\n", encoding: "utf8", size: 7 },
    },
  }));
  const read = (path?: string) =>
    readSkillFile({ path, skill: "research", skills, source: bundled });

  it("lists embedded files sorted", async () => {
    await expect(bundled.listFiles("research")).resolves.toEqual([
      "SKILL.md",
      "assets/logo.png",
      "data/huge.csv",
      "references/deep/api.md",
      "references/omitted.md",
    ]);
    await expect(bundled.listFiles("missing")).resolves.toEqual([]);
    await expect(bundled.listFiles("constructor")).resolves.toEqual([]);
  });

  it("reads text and binary files", async () => {
    await expect(read()).resolves.toBe("# Research\n");
    await expect(read("references/deep/api.md")).resolves.toBe("nested\n");
    const logo = await read("assets/logo.png");
    expect([...(logo as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  });

  it("enforces the cap and reports files left out of the bundle", async () => {
    expect((await readError(read("data/huge.csv"))).code).toBe("too-large");
    expect((await readError(read("references/omitted.md"))).code).toBe("unavailable");
    expect((await readError(read("nope.md"))).code).toBe("unknown-file");
  });
});
