import { chmod, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseEnv } from "node:util";

import { appendEnv } from "#setup/append-env.js";
import { writeTextFile } from "#setup/scaffold/files.js";
import {
  WEB_APP_SIGN_IN_WITH_VERCEL_TEMPLATE_FILES,
  WEB_APP_TEMPLATE_FILES,
  WEB_CHANNEL_TEMPLATES,
} from "#setup/scaffold/create/web-template.js";
import { resolveWebPackageVersions } from "#setup/scaffold/update/web-options.js";
import type { WebAuthEnvironment } from "./provision-auth.js";

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Checks authored files before provisioning, then returns the local scaffold operation. */
export async function prepareWebAuthScaffold(input: {
  environmentRoot: string;
  agentAppRoot: string;
  webRoot?: string;
  force?: boolean;
}): Promise<(environment: WebAuthEnvironment) => Promise<void>> {
  const webRoot = input.webRoot ?? join(input.environmentRoot, "apps", "web");
  const channelPath = join(input.agentAppRoot, "agent", "channels", "eve.ts");
  const authPath = relative(dirname(channelPath), join(webRoot, "lib", "auth.js"))
    .split(sep)
    .join("/");
  const channel = WEB_CHANNEL_TEMPLATES["sign-in-with-vercel"].replace(
    '"@/lib/auth"',
    JSON.stringify(authPath.startsWith(".") ? authPath : `./${authPath}`),
  );
  const writes = [
    ...Object.entries(WEB_APP_SIGN_IN_WITH_VERCEL_TEMPLATE_FILES)
      .filter(([path]) => path !== "app/layout.tsx")
      .map(([path, source]) => ({
        path: join(webRoot, path),
        source: source.replaceAll("__EVE_INIT_APP_NAME__", () =>
          JSON.stringify(basename(input.agentAppRoot)).slice(1, -1),
        ),
        previous: WEB_APP_TEMPLATE_FILES[path as keyof typeof WEB_APP_TEMPLATE_FILES],
      })),
    { path: channelPath, source: channel, previous: WEB_CHANNEL_TEMPLATES.default },
  ];
  for (const file of writes) {
    const current = await readOptional(file.path);
    if (
      !input.force &&
      current !== undefined &&
      current !== file.source &&
      current !== file.previous
    ) {
      throw new Error(
        `Could not add Sign in with Vercel because ${file.path} contains authored code. Preserve your changes and integrate auth manually, or retry setup with --overwrite.`,
      );
    }
  }
  const packagePath = join(input.environmentRoot, "package.json");
  return async (environment) => {
    const roots = [...new Set([input.environmentRoot, webRoot])];
    for (const root of roots) {
      const current = parseEnv((await readOptional(join(root, ".env.local"))) ?? "");
      for (const [key, value] of Object.entries(environment)) {
        if (
          key !== "EVE_WEB_CHAT_LOCAL_URL" &&
          current[key] &&
          current[key] !== value &&
          !input.force
        ) {
          throw new Error(
            `Could not save local Web Chat credentials because ${key} in ${join(root, ".env.local")} differs from the linked project. Preserve your settings and retry with --overwrite if you want to replace it.`,
          );
        }
      }
    }
    const document = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    document.dependencies = {
      ...document.dependencies,
      "better-auth":
        document.dependencies?.["better-auth"] ??
        resolveWebPackageVersions(undefined, "sign-in-with-vercel").betterAuthPackageVersion,
    };
    for (const file of writes) await writeTextFile(file.path, file.source, { force: true });
    await writeTextFile(packagePath, `${JSON.stringify(document, null, 2)}\n`, { force: true });
    await appendEnv(join(input.environmentRoot, ".env.example"), {
      VERCEL_APP_CLIENT_ID: "",
      VERCEL_APP_CLIENT_SECRET: "",
      BETTER_AUTH_SECRET: "",
      EVE_WEB_CHAT_LOCAL_URL: "http://localhost:3000",
      EVE_WEB_CHAT_SKIP_AUTH: "0",
    });
    for (const root of roots) {
      const ignorePath = join(root, ".gitignore");
      const ignore = (await readOptional(ignorePath)) ?? "";
      if (!ignore.split("\n").includes(".env.local")) {
        await writeTextFile(ignorePath, `${ignore.trimEnd()}\n.env.local\n`, { force: true });
      }
      const envPath = join(root, ".env.local");
      await appendEnv(
        envPath,
        Object.fromEntries(
          Object.entries(environment).map(([key, value]) => [
            key,
            JSON.stringify(value).replaceAll("$", "\\$"),
          ]),
        ),
        { force: true },
      );
      await chmod(envPath, 0o600);
    }
  };
}
