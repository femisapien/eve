import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  prepareWebChatProjectRoot,
  prepareWebRegistryProject,
  readRegistryConfig,
} from "./registry-project.js";

describe("readRegistryConfig", () => {
  it("reads registry mappings from an agent workspace package", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-registry-workspace-"));
    const agentRoot = join(workspaceRoot, "agents", "support");
    await mkdir(join(agentRoot, "agent"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify({
        dependencies: { eve: "*" },
        registries: { "@acme": "https://example.com/r/{name}.json" },
      }),
    );

    await expect(readRegistryConfig(agentRoot)).resolves.toEqual({
      registries: { "@acme": "https://example.com/r/{name}.json" },
    });
  });
});

describe("prepareWebRegistryProject", () => {
  it("leaves a fresh app for the registry transaction to create", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eve-registry-web-project-"));
    const tsconfigPath = join(workspaceRoot, "apps", "web", "tsconfig.json");

    await prepareWebRegistryProject(workspaceRoot);

    await expect(readFile(tsconfigPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("prepareWebChatProjectRoot", () => {
  async function createProjectRoot(scripts: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "eve-registry-web-scripts-"));
    await mkdir(join(root, "agent"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ dependencies: { eve: "*" }, scripts }),
    );
    return root;
  }

  async function readScripts(root: string): Promise<Record<string, string>> {
    return (
      JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;
  }

  it("adds Next.js web scripts by default", async () => {
    const root = await createProjectRoot({});

    await prepareWebChatProjectRoot(root);

    await expect(readScripts(root)).resolves.toEqual({
      "build:web": "next build apps/web",
      "dev:web": "next dev apps/web",
    });
  });

  it("adds Vite web scripts for TanStack Start and keeps authored scripts", async () => {
    const root = await createProjectRoot({ "dev:web": "custom" });

    await prepareWebChatProjectRoot(root, "tanstack");

    await expect(readScripts(root)).resolves.toEqual({
      "build:web": "vite build apps/web",
      "dev:web": "custom",
    });
  });
});
