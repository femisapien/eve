import { resolve } from "node:path";
import type { AgentModuleCandidate } from "#compiler/source-graph.js";
import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import { createAgentSourceManifest } from "#discover/manifest.js";
import { assertValidPublicAgentName } from "#internal/agent-name.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import {
  ENTRY_MEMBER_CATEGORIES,
  entrySourceLabel,
  readEntryDefinition,
  type EntryProjection,
} from "#internal/entry-source.js";

/** Explicit compiler selection. Host resource isolation is owned by the caller. */
export interface AgentEntrySelection {
  readonly appRoot: string;
  readonly entry: string;
  readonly registration: string;
}

export async function prepareEntrySources(selection: AgentEntrySelection) {
  assertValidPublicAgentName(selection.registration, "Agent registration");
  const appRoot = resolve(selection.appRoot);
  const context = {
    registration: selection.registration,
    sourcePath: resolve(appRoot, selection.entry),
  };
  let namespace: Readonly<Record<string, unknown>>;
  try {
    namespace = await loadAuthoredModuleNamespace(context.sourcePath);
  } catch {
    throw new Error(
      `${entrySourceLabel(context)} could not be imported. Check the entry path and its dependencies.`,
    );
  }
  const definition = readEntryDefinition(namespace, context);
  const candidates: AgentModuleCandidate[] = [];
  function add(logicalPath: string, projection: EntryProjection) {
    candidates.push({
      backing: { kind: "entry", ...context, projection, externalDependencies: [] },
      form: "direct",
      layer: "application",
      logicalPath,
      nodeId: ROOT_COMPILED_AGENT_NODE_ID,
      owner: { kind: "application" },
      sourceId: `entry:${logicalPath}`,
    });
  }
  add("agent.ts", { kind: "config" });
  if (typeof definition.instructions === "string")
    add("instructions/default.ts", { kind: "string-instructions" });
  for (const category of ENTRY_MEMBER_CATEGORIES) {
    for (const key of Object.keys(definition.maps[category])) {
      add(`${category}/${key}.ts`, { kind: "member", category, key });
    }
  }
  candidates.sort((left, right) => left.logicalPath.localeCompare(right.logicalPath));
  return {
    candidates,
    namespaces: new Map([[context.sourcePath, namespace]]),
    manifest: createAgentSourceManifest({
      appRoot,
      agentRoot: appRoot,
      agentId: selection.registration,
    }),
    project: { appRoot, agentRoot: appRoot, layout: "flat" as const },
  };
}
