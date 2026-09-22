import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  findClosestLinkedVercelDirectory,
  findClosestVercelOutputDirectory,
} from "#shared/vercel-output-directory.js";

const fake = vi.hoisted(() => ({
  files: new Set<string>(),
  error: undefined as Error | undefined,
}));

vi.mock("node:fs/promises", () => ({
  stat: async (path: string) => {
    if (fake.error) throw fake.error;
    if (!fake.files.has(path)) {
      throw Object.assign(new Error("Missing file"), { code: "ENOENT" });
    }
    return { isFile: () => true };
  },
}));

beforeEach(() => {
  fake.files.clear();
  fake.error = undefined;
});

describe("findClosestVercelOutputDirectory", () => {
  it.each(["/vercel/output", "/vercel/path0/.vercel/build-output"])(
    "finds %s from a nested app",
    async (directory) => {
      fake.files.add(`${directory}/builds.json`);
      expect(await findClosestVercelOutputDirectory("/vercel/path0/apps/web")).toBe(directory);
    },
  );

  it("chooses the nearest build regardless of its output layout", async () => {
    fake.files.add("/vercel/path0/apps/web/output/builds.json");
    fake.files.add("/vercel/path0/.vercel/build-output/builds.json");
    expect(await findClosestVercelOutputDirectory("/vercel/path0/apps/web")).toBe(
      "/vercel/path0/apps/web/output",
    );
  });

  it("prefers build-output when both layouts exist at the same ancestor", async () => {
    fake.files.add("/vercel/path0/output/builds.json");
    fake.files.add("/vercel/path0/.vercel/build-output/builds.json");
    expect(await findClosestVercelOutputDirectory("/vercel/path0/apps/web")).toBe(
      "/vercel/path0/.vercel/build-output",
    );
  });

  it("returns undefined when no build manifest exists", async () => {
    expect(await findClosestVercelOutputDirectory("/project/apps/web")).toBeUndefined();
  });

  it("propagates unexpected filesystem errors", async () => {
    fake.error = Object.assign(new Error("Permission denied"), { code: "EACCES" });
    await expect(findClosestVercelOutputDirectory("/project")).rejects.toBe(fake.error);
  });
});

it("still resolves the nearest linked project", async () => {
  fake.files.add("/project/.vercel/project.json");
  fake.files.add("/project/apps/web/.vercel/project.json");
  expect(await findClosestLinkedVercelDirectory("/project/apps/web/src")).toBe(
    "/project/apps/web/.vercel",
  );
});
