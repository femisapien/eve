import type { AgentDefinition } from "#public/definitions/agent.js";
import type { Channel, DisabledRouteSentinel } from "#public/definitions/channel.js";
import type { PublicInstructionsDefinition } from "#shared/instructions-definition.js";
import type { SkillDefinition } from "#public/definitions/skill.js";
import type { DynamicSentinel } from "#dynamic/definition.js";
import type { DisabledToolSentinel, ToolDefinition } from "#tools/definition.js";
import type { WorkflowToolDefinition } from "#tools/workflow-definition.js";
import type { WebSearchToolDefinition } from "#tools/provided/web-search.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { Approval } from "#approval/definition.js";

// Approval callbacks are contravariant in tool input, and `any` input widens
// them to records, so typed policies need the same erasure as stampToolDefinition.
type StoredToolDefinition<TTool> = TTool extends unknown
  ? Omit<TTool, "approval" | "approvalKey"> & {
      readonly approval?: Approval<never>;
      readonly approvalKey?: (...args: never[]) => unknown;
    }
  : never;

/** Complete agent authoring input. Map keys supply primitive identity. */
export type CreateAgentDefinition = AgentDefinition & {
  readonly instructions?:
    | string
    | Readonly<Record<string, PublicInstructionsDefinition | DynamicSentinel>>;
  // Definitions erase their callback input types only at the aggregate storage boundary.
  readonly tools?: Readonly<
    Record<
      string,
      | StoredToolDefinition<ToolDefinition<any, any> | WorkflowToolDefinition<any, any>>
      | WebSearchToolDefinition
      | DynamicSentinel
      | DisabledToolSentinel
    >
  >;
  readonly skills?: Readonly<Record<string, SkillDefinition | DynamicSentinel>>;
  readonly channels?: Readonly<Record<string, Channel<any, any, any> | DisabledRouteSentinel>>;
};

/** A reconstructible definition, not a running agent or compiled artifact. */
export interface CreatedAgent<TDefinition extends CreateAgentDefinition = CreateAgentDefinition> {
  readonly kind: "eve:agent";
  readonly definition: TDefinition;
}

/**
 * Defines an agent without starting work or evaluating its callbacks. Export the
 * result as the default export of an entry module selected by the compiler.
 * Imports must reproduce the same primitive membership on builds and workers.
 */
export function createAgent<const TDefinition extends CreateAgentDefinition>(
  definition: ExactDefinition<TDefinition, CreateAgentDefinition>,
): CreatedAgent<TDefinition> {
  return { kind: "eve:agent", definition };
}
