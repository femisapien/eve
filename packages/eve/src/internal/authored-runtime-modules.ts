import type { AuthoredWorkflowModules } from "#internal/workflow-bundle/builder-support.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  bundleAuthoredModuleForGeneration,
  bundleAuthoredModuleMapForGeneration,
} from "#internal/authored-module-loader.js";
import { resolveInstrumentationLayout } from "#internal/instrumentation-layout.js";
import { mapConcurrent } from "#shared/map-concurrent.js";

interface PreparedAuthoredRuntimeInstrumentation {
  readonly kind: "directory";
  readonly moduleCodeBySlot: Readonly<Record<string, string>>;
}

export interface PreparedAuthoredRuntimeModules {
  readonly authoredWorkflowModules: AuthoredWorkflowModules;
  readonly instrumentation: PreparedAuthoredRuntimeInstrumentation;
  readonly moduleMapCode: string;
  /** Identity of authored sources shared by the workflow driver and step registrations. */
  readonly workflowSourceFingerprint: string | undefined;
}

/** Builds the authored runtime graph before a development or production host packages it. */
export async function prepareAuthoredRuntimeModules(input: {
  readonly appRoot: string;
  /** Entry-mode agents have no authored directory, so instrumentation is not discovered. */
  readonly entryMode: boolean;
  readonly manifest: CompiledAgentManifest;
  readonly moduleMapPath: string;
}): Promise<PreparedAuthoredRuntimeModules> {
  const {
    authoredWorkflowModules,
    code: moduleMapCode,
    workflowSourceFingerprint,
  } = await bundleAuthoredModuleMapForGeneration(input);
  const layout = input.entryMode
    ? { modulePathsBySlot: {} }
    : resolveInstrumentationLayout({ agentRoot: input.manifest.agentRoot });
  const externalDependencies = input.manifest.config.build?.externalDependencies ?? [];
  const bundleInstrumentationModule = async (sourcePath: string): Promise<string> =>
    await bundleAuthoredModuleForGeneration(sourcePath, { externalDependencies });
  const moduleCodeBySlot = Object.fromEntries(
    await mapConcurrent(Object.entries(layout.modulePathsBySlot), async ([slot, sourcePath]) => [
      slot,
      await bundleInstrumentationModule(sourcePath),
    ]),
  );
  const instrumentation = { kind: "directory", moduleCodeBySlot } as const;

  return { authoredWorkflowModules, instrumentation, moduleMapCode, workflowSourceFingerprint };
}
