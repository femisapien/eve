export const SEARCH_TOOL_NAME = "search";
export const EXECUTE_TOOL_NAME = "execute";

/** The catalog tools' names. Every session has both, so no other entry can use them. */
export const CATALOG_TOOL_NAMES: readonly string[] = [SEARCH_TOOL_NAME, EXECUTE_TOOL_NAME];

/**
 * The name an `execute({ skill })` call takes once it resolves inside the
 * harness, where it reports as a `load-skill` action, and the tool name of a
 * skill load's client message part. The colon keeps it out of the tool
 * namespace, because skills and tools have separate names.
 */
export const SKILL_ENTRY_NAME = "eve:load-skill";
