const EVE_PROVIDED_TOOL = Symbol.for("eve.providedTool");

/**
 * Marks a tool eve provides, so it runs as usual in an eval session with tool
 * stubs, including when an app re-exports it from `agent/tools/`. The mark
 * sits on `execute`, which tool resolution keeps by reference.
 */
export function markProvidedTool<TDefinition extends { readonly execute?: unknown }>(
  definition: TDefinition,
): TDefinition {
  if (typeof definition.execute === "function") {
    Object.defineProperty(definition.execute, EVE_PROVIDED_TOOL, { value: true });
  }
  return definition;
}

/** Reports whether `execute` belongs to a tool marked by {@link markProvidedTool}. */
export function isProvidedToolExecute(execute: unknown): boolean {
  return typeof execute === "function" && Reflect.get(execute, EVE_PROVIDED_TOOL) === true;
}
