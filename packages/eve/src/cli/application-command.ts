import type { Command } from "#compiled/commander/index.js";
import type { AgentEntrySelection } from "#compiler/entry-sources.js";
import type { ResolvedDiscoveryProject } from "#discover/project.js";
import type { EveProjectContext } from "#internal/project-context.js";

export interface CliApplicationContext {
  /** Set from `EVE_INTERNAL_AGENT_SELECTION`; bypasses filesystem project discovery. */
  readonly entrySelection?: AgentEntrySelection;
  root: string;
  project?: ResolvedDiscoveryProject;
  resolve(): Promise<void>;
  resolveAgent(): Promise<EveProjectContext>;
}

type CliApplicationRootRequirement = (command: Command) => boolean;

/** Adds application-root resolution to a project-scoped CLI command. */
export function applicationCommand(
  command: Command,
  applicationContext: CliApplicationContext,
  requirement: CliApplicationRootRequirement = () => true,
): Command {
  return command.hook("preAction", async (_command, actionCommand) => {
    if (requirement(actionCommand)) await applicationContext.resolve();
  });
}
