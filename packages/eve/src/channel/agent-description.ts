import type { CompiledAgentManifest, CompiledToolDefinition } from "#compiler/manifest.js";
import type { AgentSourceOwner } from "#compiler/source-graph.js";
import {
  createCompiledSkillFileSource,
  readSkillFile,
  type SkillFileSource,
} from "#channel/skill-files.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import type { JsonObject } from "#shared/json.js";

/** One compiled tool, as the agent offers it to callers. */
export interface AgentToolDescription {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
  /** The tool declares an approval policy. */
  readonly approval: boolean;
  /** The tool can run outside a turn. */
  readonly invocable: boolean;
}

/** One compiled skill and the files `readSkill` can return for it. */
export interface AgentSkillDescription {
  readonly name: string;
  readonly description: string;
  readonly files: readonly string[];
}

/**
 * The caller-facing view of an agent: its compiled tools and skills, sorted
 * by name. Unlike `GET /eve/v1/info`, it carries no paths, config,
 * diagnostics, or other inspection detail, so channels can publish it as is.
 * Tools and skills added by dynamic resolvers and subagents are not listed.
 */
export interface AgentDescription {
  readonly name: string;
  readonly description?: string;
  readonly tools: readonly AgentToolDescription[];
  readonly skills: readonly AgentSkillDescription[];
}

/**
 * The `describe` and `readSkill` route handler args for one compiled agent.
 * The artifacts source resolves on first use, so routes that never call
 * either pay nothing.
 */
export function createAgentDescriptionRouteArgs(
  resolveCompiledArtifactsSource: () => RuntimeCompiledArtifactsSource,
): {
  describe(): Promise<AgentDescription>;
  readSkill(skill: string, path?: string): Promise<string | Uint8Array>;
} {
  const load = async () => {
    const compiledArtifactsSource = resolveCompiledArtifactsSource();
    const manifest = await loadCompiledManifest({ compiledArtifactsSource });
    const files = createCompiledSkillFileSource({
      compiledArtifactsSource,
      workspaceResourceRoot: manifest.workspaceResourceRoot,
    });
    return { files, manifest };
  };
  return {
    async describe() {
      const { files, manifest } = await load();
      return await describeCompiledAgent(manifest, files);
    },
    async readSkill(skill, path) {
      const { files, manifest } = await load();
      return await readSkillFile({
        path,
        skill,
        skills: manifest.skills.map((entry) => entry.name),
        source: files,
      });
    },
  };
}

/** Projects the root node of a compiled manifest onto {@link AgentDescription}. */
export async function describeCompiledAgent(
  manifest: CompiledAgentManifest,
  files: SkillFileSource,
): Promise<AgentDescription> {
  const tools = [...manifest.tools]
    .sort((left, right) => compareNames(left.name, right.name))
    .map((tool) => describeTool(tool, toolOwner(manifest, tool)));
  const skills = await Promise.all(
    [...manifest.skills]
      .sort((left, right) => compareNames(left.name, right.name))
      .map(async (skill) => ({
        name: skill.name,
        description: skill.description,
        files: await files.listFiles(skill.name),
      })),
  );
  const description: { -readonly [K in keyof AgentDescription]: AgentDescription[K] } = {
    name: manifest.config.name,
    tools,
    skills,
  };
  if (manifest.config.description !== undefined) {
    description.description = manifest.config.description;
  }
  return description;
}

/**
 * Whether a compiled tool can run outside a turn: it has an `execute`, no
 * special handling (`dispatch`, `workflow-tool`, `provider-tool`, or any
 * handling added later), and is not framework-provided. Framework tools such
 * as `bash` and `load_skill` depend on the turn's sandbox or harness. An
 * application tool that overrides a framework tool name is owned by the
 * application and stays invocable.
 *
 * There is no background-tool marker in the compiled registry. A background
 * tool is excluded only when one of these rules already covers it.
 */
export function isInvocableCompiledTool(
  tool: Pick<CompiledToolDefinition, "behavior" | "hasExecute">,
  owner: AgentSourceOwner,
): boolean {
  return tool.hasExecute && tool.behavior?.handling === undefined && owner.kind !== "framework";
}

function describeTool(tool: CompiledToolDefinition, owner: AgentSourceOwner): AgentToolDescription {
  const description: { -readonly [K in keyof AgentToolDescription]: AgentToolDescription[K] } = {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? {},
    approval: tool.requiresApproval,
    invocable: isInvocableCompiledTool(tool, owner),
  };
  if (tool.outputSchema !== undefined) {
    description.outputSchema = tool.outputSchema;
  }
  return description;
}

function toolOwner(manifest: CompiledAgentManifest, tool: CompiledToolDefinition) {
  const owner = manifest.bindings[tool.sourceId]?.owner;
  if (owner === undefined) {
    throw new Error(`Compiled tool "${tool.name}" has no source binding.`);
  }
  return owner;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
