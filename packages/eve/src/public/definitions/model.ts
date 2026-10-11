import { defineDynamic as defineDynamicBase, type DefineDynamic } from "#dynamic/definition.js";
import type { PublicAgentDynamicModelResult } from "#shared/agent-definition.js";

export type {
  PublicAgentDynamicModelResult as DynamicModelResult,
  PublicAgentModelSelectionDefinition as ModelSelection,
} from "#shared/agent-definition.js";

/**
 * Chooses an agent's model per session, as its `model` field. `select` reads what the choice
 * depends on, and `resolve` returns the model, or `{ model, reasoning?, modelContextWindowTokens?,
 * modelOptions? }`; eve calls it again only when the selection changes.
 *
 * ```ts
 * import { defineAgent } from "eve";
 * import { defineDynamic } from "eve/models";
 *
 * export default defineAgent({
 *   model: defineDynamic({
 *     select: (view) => view.messages.some(hasImage),
 *     resolve: (image) => (image ? "google/gemini-3.5-flash" : "zai/glm-5.2"),
 *   }),
 * });
 * ```
 *
 * A gateway ID is data, and eve records it. A provider object, such as `anthropic("...")`, is
 * code: return the JSON it's made from in `resolve`, or select it, and create it in `build`, so a
 * process that didn't choose it builds the same model from what the session recorded.
 */
export const defineDynamic = defineDynamicBase as DefineDynamic<PublicAgentDynamicModelResult>;
