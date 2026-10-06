import { join } from "node:path";

import { select } from "#setup/ask.js";
import type { PackageManagerKind } from "#setup/package-manager.js";
import { WEB_CHANNEL_TEMPLATES } from "#setup/scaffold/create/web-template.js";
import {
  defineSetupIntegration,
  type SetupApplyContext,
  type SetupPrepareContext,
} from "../types.js";
import {
  assertInstallerOwned,
  configurePeerServiceScripts,
  defaultWebSetupDeps,
  runScriptCommand,
  type WebSetupDeps,
} from "../web/setup.js";

/** The `vite.config.ts` the `channel/tanstack` registry item installs. */
export const TANSTACK_REGISTRY_VITE_CONFIG = `import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [tailwindcss(), tanstackStart({ srcDirectory: "app" }), viteReact(), nitro()],
});
`;
const TANSTACK_HOSTED_VITE_CONFIG = `import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { eveTanStack } from "eve/tanstack";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const eveRoot = fileURLToPath(new URL("../..", import.meta.url));

export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [
    eveTanStack({ eveRoot }),
    tailwindcss(),
    tanstackStart({ srcDirectory: "app" }),
    viteReact(),
    nitro(),
  ],
});
`;
const PEER_SERVICE_WEB_BUILD_COMMAND = "node ../../node_modules/vite/bin/vite.js build";
const PEER_SERVICE_VERCEL_CONFIG = `import { withEve } from "eve/vercel";

export default await withEve({
  services: {
    web: {
      framework: "tanstack-start",
      root: "apps/web",
      buildCommand: "${PEER_SERVICE_WEB_BUILD_COMMAND}",
    },
  },
  routes: [
    { src: "^(.*)$", destination: { type: "service", service: "web" } },
  ],
});
`;

interface TanStackSetupPlan {
  hosting: "tanstack" | "vercel";
  packageManager: PackageManagerKind;
}

export async function prepareTanStackSetup(
  context: SetupPrepareContext,
  deps: WebSetupDeps = defaultWebSetupDeps,
): Promise<TanStackSetupPlan> {
  const project = await deps.resolveEveProjectContext(context.appRoot);
  if (project.kind === "workspace") {
    throw new Error("Web Chat setup requires a selected workspace agent.");
  }
  // `eveTanStack()` mounts one agent, so a workspace member deploys as a peer service.
  const hosting =
    project.kind === "workspace-member"
      ? ("vercel" as const)
      : await context.asker.ask(
          select({
            key: "tanstack-hosting",
            message: "How should Web Chat and your agent be deployed?",
            options: [
              {
                id: "vercel",
                label: "Vercel services",
                hint: "(Recommended) Web Chat and the agent deploy as separate services.",
                value: "vercel" as const,
              },
              {
                id: "tanstack",
                label: "TanStack Start",
                hint: "One TanStack Start app serves Web Chat and routes agent requests.",
                value: "tanstack" as const,
              },
            ],
            recommended: "vercel" as const,
            required: true,
          }),
        );
  return {
    hosting,
    packageManager: (await deps.detectPackageManager(project.environmentRoot)).kind,
  };
}

export async function applyTanStackSetup(
  plan: TanStackSetupPlan,
  context: SetupApplyContext,
  deps: WebSetupDeps = defaultWebSetupDeps,
) {
  const project = await deps.resolveEveProjectContext(context.appRoot);
  if (project.kind === "workspace") {
    throw new Error("Web Chat setup requires a selected workspace agent.");
  }
  const agentAppRoot =
    project.kind === "workspace-member" ? project.member.appRoot : project.appRoot;
  const channelPath = join(agentAppRoot, "agent", "channels", "eve.ts");
  if (context.force || !(await deps.pathExists(channelPath))) {
    await deps.writeTextFile(channelPath, WEB_CHANNEL_TEMPLATES.default, {
      force: context.force,
    });
  }
  const agentName = project.kind === "workspace-member" ? project.member.name : undefined;
  const webRoot = join(project.environmentRoot, "apps", "web");
  await deps.writeTextFile(
    join(webRoot, "app", "eve-agent.ts"),
    `/** Named workspace agent selected by the Web Chat installer. */\nexport const WEB_CHAT_AGENT: string | undefined = ${agentName === undefined ? "undefined" : JSON.stringify(agentName)};\n`,
    { force: true },
  );
  const viteConfigPath = join(webRoot, "vite.config.ts");
  await assertInstallerOwned(viteConfigPath, [
    TANSTACK_REGISTRY_VITE_CONFIG,
    TANSTACK_HOSTED_VITE_CONFIG,
  ]);
  let startScript: string;
  if (plan.hosting === "vercel") {
    const vercelTsPath = join(project.environmentRoot, "vercel.ts");
    const vercelJsonPath = join(project.environmentRoot, "vercel.json");
    await assertInstallerOwned(vercelTsPath, [PEER_SERVICE_VERCEL_CONFIG]);
    if (await deps.pathExists(vercelJsonPath)) {
      throw new Error(
        `Could not configure Vercel services because ${vercelJsonPath} already exists. Preserve it and compose eve/vercel manually.`,
      );
    }
    await deps.writeTextFile(viteConfigPath, TANSTACK_REGISTRY_VITE_CONFIG, { force: true });
    await deps.writeTextFile(vercelTsPath, PEER_SERVICE_VERCEL_CONFIG, { force: true });
    await configurePeerServiceScripts(project.environmentRoot, deps);
    startScript = "dev:all";
  } else {
    await deps.writeTextFile(viteConfigPath, TANSTACK_HOSTED_VITE_CONFIG, { force: true });
    startScript = "dev:web";
  }
  context.presenter.log.success("Configured channel: tanstack");
  return {
    facts: [
      {
        label: "",
        value: `Start locally with \`${runScriptCommand(plan.packageManager, startScript)}\`.`,
      },
    ],
  };
}

export const TANSTACK_SETUP = defineSetupIntegration({
  kind: "tanstack",
  label: "Web Chat (TanStack Start)",
  hint: "Browser-based chat interface in a TanStack Start app",
  prepare: prepareTanStackSetup,
  apply: applyTanStackSetup,
});
