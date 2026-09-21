import { z } from "#compiled/zod/index.js";

import { loadContext } from "#context/container.js";
import { DynamicSkillManifestKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { stripSkillFrontmatter } from "#runtime/skills/sandbox-access.js";

/**
 * Typed input accepted by {@link executeLoadSkillTool}.
 */
type LoadSkillInput = z.infer<typeof SKILL_INPUT_SCHEMA>;

/**
 * Executes the `load_skill` tool.
 *
 * Returns authored skill instructions directly from the resolved agent.
 * Active dynamic skills take precedence and retain their instructions in
 * durable context, independent of sandbox materialization.
 */
async function executeLoadSkillTool(args: LoadSkillInput): Promise<unknown> {
  const ctx = loadContext();
  const { skill } = args;
  const authoredSkills = ctx.require(BundleKey).resolvedAgent.skills;
  const dynamicSkills = Object.values(ctx.get(DynamicSkillManifestKey) ?? {}).flat();
  const availableSkills = [
    ...new Set([...authoredSkills, ...dynamicSkills].map((entry) => entry.name)),
  ].sort();

  try {
    const dynamicSkill = dynamicSkills.find((entry) => entry.name === skill);
    if (dynamicSkill !== undefined) {
      return stripSkillFrontmatter(dynamicSkill.markdown);
    }

    const authoredSkill = authoredSkills.find((entry) => entry.name === skill);
    if (authoredSkill !== undefined) {
      return authoredSkill.markdown;
    }

    throw new Error(formatSkillNotFoundError(skill, availableSkills));
  } catch (error) {
    const connectionName = ctx
      .get(ConnectionRegistryKey)
      ?.getConnectionNames()
      .find((name) => name.toLowerCase() === skill.toLowerCase());
    if (connectionName === undefined || availableSkills.includes(skill)) throw error;

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message} "${connectionName}" is an installed connection, not a skill. ` +
        `Use connection_search with connection "${connectionName}" to find its tools.`,
      { cause: error },
    );
  }
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
