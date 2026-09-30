/** Canonical file name of a skill package's entry markdown. */
export const SKILL_ENTRY_FILE_NAME = "SKILL.md";

/**
 * Whether a file name is a skill package's entry markdown. Discovery accepts
 * any case variant, such as `skill.md` or `Skill.MD`, and materialization keeps
 * the authored name, so readers must match with this rather than comparing
 * against {@link SKILL_ENTRY_FILE_NAME}.
 */
export function isSkillEntryFileName(name: string): boolean {
  return name.toLowerCase() === "skill.md";
}
