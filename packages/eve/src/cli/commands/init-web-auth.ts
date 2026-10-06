import { interactiveAsker } from "#setup/ask.js";
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import {
  WEB_AUTHENTICATION_QUESTION,
  WEB_CHAT_TEAM_REQUIREMENT,
} from "#setup/integrations/web/auth-options.js";
import { provisionWebChatAuth } from "#setup/integrations/web/provision-auth.js";
import { installScaffoldDependencies } from "#setup/integrations/shared/scaffold.js";
import { createSetupPresenter } from "#setup/integrations/shared/ui.js";
import { setupWebAuth } from "#setup/integrations/web/setup-auth.js";
import { createPrompter } from "#setup/prompter.js";
import { readProjectLink } from "#setup/project-resolution.js";
import { WizardCancelledError } from "#setup/step.js";

import type { InitCliLogger, InitCommandOptions } from "./init-agent-workspace.js";
import { runNonInteractiveLink } from "./vercel-non-interactive.js";

export interface InitWebAuthDeps {
  createPrompter: typeof createPrompter;
  ensureVercelProject: typeof ensureVercelProject;
  installScaffoldDependencies: typeof installScaffoldDependencies;
  provisionWebChatAuth: typeof provisionWebChatAuth;
  readProjectLink: typeof readProjectLink;
  runNonInteractiveLink: typeof runNonInteractiveLink;
}

const defaultDeps: InitWebAuthDeps = {
  createPrompter,
  ensureVercelProject,
  installScaffoldDependencies,
  provisionWebChatAuth,
  readProjectLink,
  runNonInteractiveLink,
};

export async function resolveInitWebAuthentication(input: {
  interactive: boolean;
  options: InitCommandOptions;
  deps?: Partial<InitWebAuthDeps>;
}): Promise<"vercel" | "custom"> {
  if (input.options.webAuthentication !== undefined) return input.options.webAuthentication;
  if (!input.interactive) return "custom";
  const prompter = (input.deps?.createPrompter ?? createPrompter)();
  return interactiveAsker(prompter).ask(WEB_AUTHENTICATION_QUESTION);
}

/** Runs after the local app is installed, so a remote failure preserves a usable project. */
export async function runInitWebAuth(input: {
  appRoot: string;
  interactive: boolean;
  options: InitCommandOptions;
  logger: InitCliLogger;
  deps?: Partial<InitWebAuthDeps>;
}): Promise<void> {
  const deps = { ...defaultDeps, ...input.deps };
  const prompter = deps.createPrompter();
  const resume = `Web Chat was created at ${input.appRoot}. To finish sign-in setup, run \`eve link\` there if needed, then \`eve add channel/web --skip-install\`. Do not rerun eve init.`;
  try {
    if (input.options.webAuthentication !== "vercel") {
      input.logger.log(
        "Web Chat uses the current channel auth. Configure authentication before deploying.",
      );
      return;
    }
    if (input.options.project !== undefined) {
      const linked = await deps.runNonInteractiveLink({
        logger: input.logger,
        appRoot: input.appRoot,
        options: { project: input.options.project, team: input.options.team, nonInteractive: true },
        teamRequirement: WEB_CHAT_TEAM_REQUIREMENT,
      });
      if (!linked) throw new Error("Vercel project linking did not complete.");
    }
    const project = input.interactive
      ? await deps.ensureVercelProject({
          appRoot: input.appRoot,
          prompter,
          allowLogin: true,
          teamRequirement: WEB_CHAT_TEAM_REQUIREMENT,
        })
      : await deps.readProjectLink(input.appRoot);
    if (project === undefined) {
      throw new Error(
        "Sign in with Vercel requires a linked project. Pass --project <name-or-id> (and --team <slug-or-id>) for non-interactive initialization.",
      );
    }
    await setupWebAuth(
      {
        project,
        environmentRoot: input.appRoot,
        presenter: createSetupPresenter(prompter),
      },
      deps,
    );
  } catch (error) {
    if (error instanceof WizardCancelledError) {
      input.logger.log(resume);
      throw error;
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${resume}`, {
      cause: error,
    });
  }
}
