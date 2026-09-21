import { z } from "#compiled/zod/index.js";

import { loadContext } from "#context/container.js";
import { DynamicSkillManifestKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

/**
 * Typed input accepted by {@link executeLoadSkillTool}.
 */
type LoadSkillInput = z.infer<typeof SKILL_INPUT_SCHEMA>;

/**
 * Executes the `load_skill` tool.
 *
 * Returns resolved instructions from memory. Dynamic skills take precedence;
 * both sources retain instruction bodies independently of sandbox files.
 */
async function executeLoadSkillTool(args: LoadSkillInput): Promise<unknown> {
  const ctx = loadContext();
  const { skill } = args;
  const skills = [
    ...Object.values(ctx.get(DynamicSkillManifestKey) ?? {}).flat(),
    ...ctx.require(BundleKey).resolvedAgent.skills,
  ];
  const selected = skills.find((entry) => entry.name === skill);
  if (selected !== undefined) return selected.markdown;

  const availableSkills = [...new Set(skills.map((entry) => entry.name))].sort();
  const error = new Error(formatSkillNotFoundError(skill, availableSkills));
  const connectionName = ctx
    .get(ConnectionRegistryKey)
    ?.getConnectionNames()
    .find((name) => name.toLowerCase() === skill.toLowerCase());
  if (connectionName === undefined) throw error;

  throw new Error(
    `${error.message} "${connectionName}" is an installed connection, not a skill. ` +
      `Use connection_search with connection "${connectionName}" to find its tools.`,
    { cause: error },
  );
}

function formatSkillNotFoundError(skill: string, availableSkills: readonly string[]): string {
  const hint =
    availableSkills.length > 0 ? ` Available skills: ${availableSkills.join(", ")}.` : "";
  return `No skill named "${skill}".${hint}`;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const SKILL_INPUT_SCHEMA = z.strictObject({
  skill: z.string().describe("Available skill name or id."),
});
export const SKILL_OUTPUT_SCHEMA = z.string();

export async function executeLoadSkill(input: unknown): Promise<unknown> {
  return await executeLoadSkillTool(input as LoadSkillInput);
}
