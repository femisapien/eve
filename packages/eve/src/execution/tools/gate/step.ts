import { ContextContainer, contextStorage } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { AuthKey, InitiatorAuthKey, SessionIdKey, SessionKey } from "#context/keys.js";
import type { SessionContext } from "#context/session-context.js";
import type { AgentSessionBundle } from "#execution/agent-sessions/context.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { CONNECTION_EXECUTE_TOOL_NAME } from "#execution/tools/connection-target.js";
import { executeConnectionTool } from "#execution/tools/connection-tools.js";
import { ConnectionRegistryImpl } from "#runtime/connections/registry.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { isAuthorizationSignal } from "#harness/authorization.js";
import { resolveDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { findRegisteredRuntimeTool } from "#runtime/tools/registry.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

/** One approved call, as the gate body hands it to its step. */
export interface GatedToolCall {
  readonly bundle: AgentSessionBundle;
  readonly callId: string;
  readonly input: JsonObject;
  readonly session: SessionContext["session"];
  readonly toolName: string;
}

/**
 * Runs one approved call to a tool from the agent's registry, as the call's
 * caller. The tool runs outside the turn's model step, so it has no model
 * messages, and sign-ins it needs fail the call.
 */
export async function runGatedToolCallStep(call: GatedToolCall): Promise<JsonValue> {
  "use step";

  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: resolveDurableCompiledArtifactsSource(call.bundle.source),
    nodeId: call.bundle.nodeId,
  });
  const context = new ContextContainer();
  const execute =
    call.toolName === CONNECTION_EXECUTE_TOOL_NAME
      ? connectionExecute(bundle.resolvedAgent?.connections ?? [], context)
      : findRegisteredRuntimeTool(bundle.toolRegistry, call.toolName)?.definition.execute;
  if (execute === undefined) {
    throw new Error(
      `Tool "${call.toolName}" can't run in this deployment: it was renamed or removed after the call was approved.`,
    );
  }

  context.set(AuthKey, call.session.auth.current);
  context.set(InitiatorAuthKey, call.session.auth.initiator);
  context.set(SessionIdKey, call.session.id);
  context.setVirtualContext(SessionKey, { ...call.session, sessionId: call.session.id });

  const run = createToolExecuteWithAuth({
    execute: execute as (input: unknown, ctx: unknown) => unknown,
    scope: call.toolName,
  });
  const output: unknown = await contextStorage.run(context, async () =>
    run(call.input, { messages: [], toolCallId: call.callId }),
  );
  if (isAuthorizationSignal(output)) {
    throw new Error(
      `${call.toolName} needs a sign-in, and this version of eve cannot ask for one from an approved call. The call did not run.`,
    );
  }
  return (output ?? null) as JsonValue;
}

/** `connection_execute` against the agent's declared connections, the only ones it can gate. */
function connectionExecute(
  connections: readonly ResolvedConnectionDefinition[],
  context: ContextContainer,
): (input: unknown, ctx: never) => Promise<unknown> {
  context.set(ConnectionRegistryKey, new ConnectionRegistryImpl(connections));
  return (input, ctx) => executeConnectionTool({}, input, ctx);
}
