import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WEB_APP_TEMPLATE_FILES,
  WEB_CHANNEL_TEMPLATES,
} from "#setup/scaffold/create/web-template.js";
import { prepareWebAuthScaffold } from "./auth-scaffold.js";

const environment = {
  VERCEL_APP_CLIENT_ID: "cl_test",
  VERCEL_APP_CLIENT_SECRET: "dev-client-secret",
  BETTER_AUTH_SECRET: "dev-session-secret",
  EVE_WEB_CHAT_LOCAL_URL: "http://localhost:3000",
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(member = "") {
  const environmentRoot = await mkdtemp(join(tmpdir(), "eve-web-auth-"));
  roots.push(environmentRoot);
  const agentAppRoot = join(environmentRoot, member);
  const channelPath = join(agentAppRoot, "agent/channels/eve.ts");
  const packagePath = join(environmentRoot, "package.json");
  await mkdir(dirname(channelPath), { recursive: true });
  await writeFile(channelPath, WEB_CHANNEL_TEMPLATES.default);
  await writeFile(
    packagePath,
    JSON.stringify({
      scripts: { "dev:all": "vercel dev --local" },
      dependencies: { eve: "latest" },
    }),
  );
  for (const [path, source] of Object.entries(WEB_APP_TEMPLATE_FILES)) {
    const file = join(environmentRoot, "apps/web", path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, source.replaceAll("__EVE_INIT_APP_NAME__", "eve Next.js Starter"));
  }
  return { environmentRoot, agentAppRoot, channelPath, packagePath };
}

describe("Web Chat auth scaffold", () => {
  it.each(["", "agents/support"])(
    "wires the real channel to the shared auth module from %s and can be retried",
    async (member) => {
      const input = await fixture(member);
      const layoutPath = join(input.environmentRoot, "apps/web/app/layout.tsx");
      const layout = await readFile(layoutPath, "utf8");
      const write = await prepareWebAuthScaffold(input);
      await write(environment);
      const signIn = await readFile(
        join(input.environmentRoot, "apps/web/app/_components/web-chat-auth.tsx"),
        "utf8",
      );
      expect(signIn).toContain(JSON.stringify(basename(input.agentAppRoot)));
      expect(signIn).not.toContain("__EVE_INIT_APP_NAME__");
      const channel = await readFile(input.channelPath, "utf8");
      const importPath = /import \{ auth, skipLocalAuth \} from "(.+)"/.exec(channel)?.[1];
      expect(importPath).toBeDefined();
      expect(resolve(dirname(input.channelPath), importPath!)).toBe(
        join(input.environmentRoot, "apps/web/lib/auth.js"),
      );
      expect(await readFile(join(input.environmentRoot, "apps/web/lib/auth.ts"), "utf8")).toContain(
        'requireEnvironmentVariable("BETTER_AUTH_SECRET")',
      );
      for (const root of [input.environmentRoot, join(input.environmentRoot, "apps/web")]) {
        expect(await readFile(join(root, ".env.local"), "utf8")).toContain(
          'VERCEL_APP_CLIENT_SECRET="dev-client-secret"',
        );
        expect(await readFile(join(root, ".gitignore"), "utf8")).toContain(".env.local");
      }
      const document = JSON.parse(await readFile(input.packagePath, "utf8"));
      expect(document.dependencies["better-auth"]).toBeDefined();
      expect(document.scripts["dev:all"]).toBe("vercel dev --local");
      expect(await readFile(layoutPath, "utf8")).toBe(layout);
      await (
        await prepareWebAuthScaffold(input)
      )(environment);
      expect(await readFile(input.channelPath, "utf8")).toBe(channel);
    },
  );

  it("preserves unrelated local settings and refuses conflicting credentials", async () => {
    const input = await fixture();
    const envPath = join(input.environmentRoot, ".env.local");
    await writeFile(envPath, "CUSTOM_SETTING=keep-me\nVERCEL_APP_CLIENT_SECRET=authored-secret\n");
    const write = await prepareWebAuthScaffold(input);
    await expect(write(environment)).rejects.toThrow("differs from the linked project");
    expect(await readFile(envPath, "utf8")).toContain("authored-secret");
    await writeFile(envPath, "CUSTOM_SETTING=keep-me\n");
    await write(environment);
    expect(await readFile(envPath, "utf8")).toContain("CUSTOM_SETTING=keep-me");
  });

  it("rejects custom auth before the caller provisions resources or writes files", async () => {
    const input = await fixture();
    await writeFile(input.channelPath, "// existing application auth\n");
    await expect(prepareWebAuthScaffold(input)).rejects.toThrow("contains authored code");
    expect(await readFile(input.channelPath, "utf8")).toBe("// existing application auth\n");
    expect(
      JSON.parse(await readFile(input.packagePath, "utf8")).dependencies["better-auth"],
    ).toBeUndefined();
  });
});
