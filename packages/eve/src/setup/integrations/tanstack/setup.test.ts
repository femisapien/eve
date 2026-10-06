import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";
import type { EveProjectContext } from "#internal/project-context.js";
import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, interactiveAsker, withAnswers } from "#setup/ask.js";
import { integrationSetupEnvironment } from "../shared/environment.js";
import { createSetupContexts } from "../shared/ui.js";
import type { WebSetupDeps } from "../web/setup.js";
import {
  applyTanStackSetup,
  prepareTanStackSetup,
  TANSTACK_REGISTRY_VITE_CONFIG,
} from "./setup.js";

function deps(): WebSetupDeps {
  return {
    detectPackageManager: vi.fn<WebSetupDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "lockfile",
    })),
    pathExists: vi.fn(async () => false),
    readTextFile: vi.fn(async () => '{"scripts":{"dev":"eve dev"}}\n'),
    resolveEveProjectContext: vi.fn(async (appRoot: string): Promise<EveProjectContext> => ({
      appRoot,
      environmentRoot: appRoot,
      kind: "standalone",
    })),
    writeTextFile: vi.fn(async () => {}),
  };
}

function contexts(asker = headlessAsker(), appRoot = "/project") {
  return createSetupContexts({
    appRoot,
    asker,
    environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
    prompter: createFakePrompter().prompter,
    resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
  });
}

const supportMember: EveProjectContext = {
  environmentRoot: "/project",
  kind: "workspace-member",
  member: { appRoot: "/project/agents/support", name: "support" },
  workspace: {
    root: "/project",
    members: [{ appRoot: "/project/agents/support", name: "support" }],
  },
};

describe("TanStack Start Web Chat setup", () => {
  it("presents the hosting topology with concise guidance", async () => {
    const fake = createFakePrompter({ single: () => "vercel" });
    const select = vi.spyOn(fake.prompter, "select");
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: interactiveAsker(fake.prompter),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: fake.prompter,
      resolveVercelProject: async () => ({ orgId: "team", projectId: "project" }),
    });

    await prepareTanStackSetup(ctx.prepare, deps());

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "How should Web Chat and your agent be deployed?",
        initialValue: "vercel",
        options: [
          {
            value: "vercel",
            label: "Vercel services",
            hint: "(Recommended) Web Chat and the agent deploy as separate services.",
            featured: undefined,
          },
          {
            value: "tanstack",
            label: "TanStack Start",
            hint: "One TanStack Start app serves Web Chat and routes agent requests.",
            featured: undefined,
          },
        ],
      }),
    );
  });

  it("uses the answered hosting without a Vercel project", async () => {
    const resolveVercelProject = vi.fn(async () => ({ orgId: "team", projectId: "project" }));
    const ctx = createSetupContexts({
      appRoot: "/project",
      asker: withAnswers({ "tanstack-hosting": "tanstack" })(headlessAsker()),
      environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
      prompter: createFakePrompter().prompter,
      resolveVercelProject,
    });

    await expect(prepareTanStackSetup(ctx.prepare, deps())).resolves.toEqual({
      hosting: "tanstack",
      packageManager: "pnpm",
    });
    expect(resolveVercelProject).not.toHaveBeenCalled();
  });

  it("deploys a workspace member as a peer service without asking", async () => {
    const effects = deps();
    vi.mocked(effects.resolveEveProjectContext).mockResolvedValue(supportMember);

    await expect(
      prepareTanStackSetup(contexts(headlessAsker(), "/project/agents/support").prepare, effects),
    ).resolves.toEqual({ hosting: "vercel", packageManager: "pnpm" });
  });

  it("rejects an unselected workspace before writing", async () => {
    const effects = deps();
    vi.mocked(effects.resolveEveProjectContext).mockResolvedValue({
      environmentRoot: "/project",
      kind: "workspace",
      workspace: supportMember.kind === "workspace-member" ? supportMember.workspace : undefined!,
    });

    await expect(
      applyTanStackSetup({ hosting: "vercel", packageManager: "pnpm" }, contexts().apply, effects),
    ).rejects.toThrow("Web Chat setup requires a selected workspace agent.");
    expect(effects.writeTextFile).not.toHaveBeenCalled();
  });

  it("names the selected workspace agent for the chat app", async () => {
    const effects = deps();
    vi.mocked(effects.resolveEveProjectContext).mockResolvedValue(supportMember);

    await applyTanStackSetup(
      { hosting: "vercel", packageManager: "pnpm" },
      contexts(headlessAsker(), "/project/agents/support").apply,
      effects,
    );

    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agents/support/agent/channels/eve.ts",
      expect.any(String),
      { force: undefined },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/apps/web/app/eve-agent.ts",
      expect.stringContaining('WEB_CHAT_AGENT: string | undefined = "support"'),
      { force: true },
    );
  });

  it("configures Vercel services for a standalone agent and returns the local command", async () => {
    const effects = deps();

    await expect(
      applyTanStackSetup({ hosting: "vercel", packageManager: "npm" }, contexts().apply, effects),
    ).resolves.toEqual({
      facts: [{ label: "", value: "Start locally with `npm run dev:all`." }],
    });

    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/apps/web/vite.config.ts",
      TANSTACK_REGISTRY_VITE_CONFIG,
      { force: true },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/vercel.ts",
      expect.stringContaining('framework: "tanstack-start"'),
      { force: true },
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/package.json",
      expect.stringContaining('"dev:all": "vercel dev --local"'),
      { force: true },
    );
  });

  it("mounts the agent with eveTanStack for single-app hosting", async () => {
    const effects = deps();

    await expect(
      applyTanStackSetup(
        { hosting: "tanstack", packageManager: "yarn" },
        contexts().apply,
        effects,
      ),
    ).resolves.toEqual({
      facts: [{ label: "", value: "Start locally with `yarn dev:web`." }],
    });

    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/apps/web/vite.config.ts",
      expect.stringContaining("eveTanStack({ eveRoot })"),
      { force: true },
    );
    expect(effects.writeTextFile).not.toHaveBeenCalledWith(
      "/project/vercel.ts",
      expect.anything(),
      expect.anything(),
    );
  });

  it("matches the vite.config.ts the registry item installs", async () => {
    await expect(
      readFile(
        new URL(
          "../../../../../../apps/docs/registry/channel/tanstack/vite.config.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ).resolves.toBe(TANSTACK_REGISTRY_VITE_CONFIG);
  });
});
