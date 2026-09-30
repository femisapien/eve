import type { AgentSourceOwner } from "#compiler/source-graph.js";

/**
 * Framework-owned tool name used to load one available compiled skill.
 */
export const LOAD_SKILL_TOOL_NAME = "load_skill";

/** Whether a tool is the framework `load_skill`, which the harness runs as a framework action. */
export function isFrameworkLoadSkillTool(tool: {
  readonly name: string;
  readonly owner: AgentSourceOwner;
}): boolean {
  return tool.owner.kind === "framework" && tool.name === LOAD_SKILL_TOOL_NAME;
}
