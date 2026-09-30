import type { InvokeToolFn } from "#channel/invoke-tool.js";
import { createNodeHarnessTools } from "#execution/node-step.js";
import { invokeToolInSession, type ToolSessionRuntime } from "#execution/tool-session/invoke.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import {
  type NitroArtifactsConfig,
  resolveNitroCompiledArtifactsSource,
} from "#internal/nitro/routes/runtime-artifacts.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { loadCompiledManifest } from "#runtime/loaders/manifest.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";

/**
 * Builds the route's `invokeTool`. The agent's static tools and sandbox load on
 * the first call, so routes that never invoke a tool pay nothing.
 */
export function createRouteInvokeTool(input: {
  readonly config: NitroArtifactsConfig;
  readonly requestUrl: string;
}): InvokeToolFn {
  let runtime: Promise<ToolSessionRuntime> | undefined;
  return async (name, toolInput, options) => {
    runtime ??= loadToolSessionRuntime({
      callbackBaseUrl: resolveWorkflowCallbackBaseUrl(new URL(input.requestUrl).origin),
      compiledArtifactsSource: resolveNitroCompiledArtifactsSource(input.config),
    }).catch((error: unknown) => {
      runtime = undefined;
      throw error;
    });
    return await invokeToolInSession(await runtime, name, toolInput, options);
  };
}

/** Loads the root agent's static tools and sandbox. Dynamic resolvers are not run. */
export async function loadToolSessionRuntime(input: {
  readonly callbackBaseUrl: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<ToolSessionRuntime> {
  const { compiledArtifactsSource } = input;
  const [bundle, manifest] = await Promise.all([
    getCompiledRuntimeAgentBundle({ compiledArtifactsSource }),
    loadCompiledManifest({ compiledArtifactsSource }),
  ]);
  const node = bundle.graph.root;
  return {
    bundle,
    callbackBaseUrl: input.callbackBaseUrl,
    compiledArtifactsSource,
    manifest,
    nodeId: node.nodeId,
    sandboxRegistry: node.sandboxRegistry,
    tools: createNodeHarnessTools({ node }),
  };
}
