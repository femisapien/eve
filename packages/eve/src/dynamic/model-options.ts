const READS_CONVERSATION = Symbol.for("eve.model-reads-conversation");

/**
 * Marks eve's own model definition, such as auto()'s, whose `resolve` reads the conversation
 * before the turn, which an authored `resolve` can't. That's safe because eve records what
 * `resolve` returns and builds the model from it, so the decision never runs again for the same
 * selection. Not public.
 */
export function readingConversation<T extends object>(definition: T): T {
  Object.defineProperty(definition, READS_CONVERSATION, { value: true });
  return definition;
}

export function readsConversation(definition: unknown): boolean {
  return typeof definition === "object" && definition !== null && READS_CONVERSATION in definition;
}
