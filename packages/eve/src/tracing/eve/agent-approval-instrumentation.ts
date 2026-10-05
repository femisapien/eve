import type {
  InstrumentationHandlerContext,
  InstrumentationInputRequestedEvent,
  InstrumentationInputResolvedEvent,
  InstrumentationProviderDefinition,
} from "#instrumentation/lifecycle.js";
import { resumeAction } from "#tracing/eve/agent-action-instrumentation.js";
import type { AgentActionTraceState } from "#tracing/eve/agent-trace-state.js";
import type { AgentTracing } from "#tracing/lib/index.js";

/** Approval spans live in their action's trace tree; hook state keeps only the locator. */
export function createAgentApprovalInstrumentation(input: {
  readonly tracing: AgentTracing;
  readonly actionStateFor: (
    sessionId: string,
    turnId: string,
    callId: string,
  ) => Promise<AgentActionTraceState | undefined>;
}): Pick<
  NonNullable<InstrumentationProviderDefinition["events"]>,
  "input.requested" | "input.resolved"
> {
  async function actionFor(sessionId: string, turnId: string, callId: string) {
    const state = await input.actionStateFor(sessionId, turnId, callId);
    return state === undefined ? undefined : resumeAction(input.tracing, state);
  }

  async function onRequested(
    event: InstrumentationInputRequestedEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> {
    if (event.kind !== "tool-approval" || ctx.state.get() !== undefined) return;
    const action = await actionFor(event.scope.sessionId, event.scope.turnId, event.action.callId);
    const approval = await action?.approval({ requestId: event.requestId, request: event.request });
    if (approval === undefined) return;
    ctx.state.set({
      callId: event.action.callId,
      sessionId: event.scope.sessionId,
      turnId: event.scope.turnId,
    });
  }

  async function onResolved(
    event: InstrumentationInputResolvedEvent,
    ctx: InstrumentationHandlerContext,
  ): Promise<void> {
    const stored = ctx.state.get();
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return;
    const { callId, sessionId, turnId } = stored as Record<string, unknown>;
    if (typeof callId !== "string" || typeof sessionId !== "string" || typeof turnId !== "string")
      return;
    const approval = (await actionFor(sessionId, turnId, callId))?.findApproval(event.requestId);
    if (approval === undefined) return;
    if (event.outcome === "failed") await approval.fail(event.error);
    else
      await approval.complete({
        outcome: event.outcome as "approved" | "denied" | "cancelled" | "ignored" | "invalid",
        response: event.response,
      });
  }

  return { "input.requested": onRequested, "input.resolved": onResolved };
}
