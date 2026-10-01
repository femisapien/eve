import type { SessionContext } from "#context/session-context.js";
import type { AgentSessionContext } from "#execution/agent-sessions/context.js";
import { findWorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import { runGatedToolCallStep } from "#execution/tools/gate/step.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

/** What the gate body reads from a `task` call's context. */
interface GateContext {
  readonly callId: string;
  readonly session: SessionContext["session"];
  readonly toolName: string;
}

/**
 * The `task` body of every gated call to a tool that is not a workflow tool.
 * The run asked a person and got an approval before this body starts, so the
 * body only runs the tool, in a step, as the call's caller.
 */
export async function gatedToolCallWorkflow(
  input: JsonObject,
  ctx: GateContext,
): Promise<JsonValue> {
  "use workflow";

  const agentContext: AgentSessionContext | undefined =
    findWorkflowToolRunContext(ctx)?.agentContext;
  if (agentContext === undefined) {
    throw new Error(`The gated call to "${ctx.toolName}" has no run context.`);
  }
  return await runGatedToolCallStep({
    bundle: agentContext.bundle,
    callId: ctx.callId,
    input,
    session: ctx.session,
    toolName: ctx.toolName,
  });
}
