import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { createChannelNameDiagnostic, TOOL_SLUG_PATTERN } from "#discover/grammar.js";

export type EntryProjection =
  | { readonly kind: "config" }
  | { readonly kind: "string-instructions" }
  | {
      readonly kind: "member";
      readonly category: EntryMemberCategory;
      readonly key: string;
    };

export const ENTRY_MEMBER_CATEGORIES = ["instructions", "tools", "skills", "channels"] as const;
export type EntryMemberCategory = (typeof ENTRY_MEMBER_CATEGORIES)[number];

export interface EntrySourceContext {
  readonly registration: string;
  readonly sourcePath: string;
}

function label(value: string): string {
  return JSON.stringify(value.slice(0, 240));
}

export function entrySourceLabel(context: EntrySourceContext): string {
  return `Agent ${label(context.registration)} entry ${label(context.sourcePath)}`;
}

function record(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

/** Validates structure without invoking authored callbacks. */
export function readEntryDefinition(
  namespace: Readonly<Record<string, unknown>>,
  context: EntrySourceContext,
) {
  const message = `${entrySourceLabel(context)} must default-export a createAgent definition.`;
  const aggregate = record(namespace.default, message);
  if (aggregate.kind !== "eve:agent") throw new Error(message);
  const definition = record(aggregate.definition, message);
  const { instructions, tools, skills, channels, ...config } = definition;
  const maps: Record<EntryMemberCategory, Record<string, unknown>> = {
    instructions: {},
    tools: {},
    skills: {},
    channels: {},
  };
  for (const [category, value] of Object.entries({ instructions, tools, skills, channels }) as [
    EntryMemberCategory,
    unknown,
  ][]) {
    if (value === undefined || (category === "instructions" && typeof value === "string")) continue;
    const map = record(value, `${entrySourceLabel(context)} ${category} must be a keyed record.`);
    for (const key of Object.keys(map)) {
      const valid =
        category === "channels"
          ? createChannelNameDiagnostic(key, context.sourcePath) === null
          : TOOL_SLUG_PATTERN.test(key);
      if (!valid)
        throw new Error(
          `${entrySourceLabel(context)} ${category} key ${label(key)} violates the ${category === "channels" ? "channel-segment" : "[A-Za-z][A-Za-z0-9_-]{0,63}"} name rule; nesting is not supported.`,
        );
    }
    maps[category] = map;
  }
  // Keep the authored config intact for runtime model resolution; normalization
  // validates it but must not replace executable authored values in the namespace.
  try {
    normalizeAgentDefinition(config, `${entrySourceLabel(context)} has invalid configuration.`);
  } catch {
    throw new Error(
      `${entrySourceLabel(context)} has invalid configuration. Use the defineAgent configuration shape, including a model and only supported configuration keys.`,
    );
  }
  return { config, instructions, maps };
}

/** Shared by compilation and emitted worker module maps. */
export function projectEntryNamespace(
  namespace: Readonly<Record<string, unknown>>,
  projection: EntryProjection,
  context: EntrySourceContext,
): Readonly<Record<string, unknown>> {
  const definition = readEntryDefinition(namespace, context);
  if (projection.kind === "config") return { default: definition.config };
  if (projection.kind === "string-instructions") {
    if (typeof definition.instructions !== "string")
      throw new Error(`${entrySourceLabel(context)} is missing string instructions.`);
    return { default: { content: definition.instructions, role: "system" } };
  }
  const map = definition.maps[projection.category];
  if (
    !Object.prototype.propertyIsEnumerable.call(map, projection.key) ||
    map[projection.key] === undefined
  ) {
    throw new Error(
      `${entrySourceLabel(context)} is missing ${projection.category} key ${label(projection.key)}.`,
    );
  }
  return { default: map[projection.key] };
}
