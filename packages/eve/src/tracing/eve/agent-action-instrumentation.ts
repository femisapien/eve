import { ROOT_CONTEXT, type Context, type SpanContext, trace } from "@opentelemetry/api";

import type {
  InstrumentationActionStartedEvent,
  InstrumentationActionTerminalEvent,
  InstrumentationAttemptScope,
  InstrumentationProviderDefinition,
} from "#instrumentation/lifecycle.js";
import { actionIdempotencyKey } from "#instrumentation/lifecycle.js";
import type {
  AgentActionTraceState,
  AgentTraceStateStore,
} from "#tracing/eve/agent-trace-state.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";
import { withChannelAudience } from "#tracing/eve/channel-audience-context.js";
import { eveTurnIdentity } from "#tracing/eve/operation-input.js";
import type { ActionOperation, AgentTracing, AttemptOperation } from "#tracing/lib/index.js";

interface AgentActionInstrumentation {
  readonly events: Pick<
    NonNullable<InstrumentationProviderDefinition["events"]>,
    "action.completed" | "action.failed" | "action.started"
  >;
  deleteForSession(sessionId: string): void | PromiseLike<void>;
  forgetAttempt(scope: InstrumentationAttemptScope): Promise<void>;
  contextFor(
    sessionId: string,
    turnId: string,
    callId: string,
  ): Promise<AgentActionContext | undefined>;
  stateFor(
    sessionId: string,
    turnId: string,
    callId: string,
  ): Promise<AgentActionTraceState | undefined>;
}

export interface AgentActionContext {
  readonly context: Context;
  readonly spanContext: SpanContext;
}

/** Finds an action in its turn's trace tree, in this or a later process. */
export async function resumeAction(
  tracingFor: (agentName: string | undefined) => AgentTracing,
  state: AgentActionTraceState,
): Promise<ActionOperation | undefined> {
  try {
    const turn = await tracingFor(state.agentName).resume({
      identity: eveTurnIdentity(state),
      context: withChannelAudience(ROOT_CONTEXT, state.channelAudience),
    });
    const attempt = await turn?.attempt({
      stepIndex: state.stepIndex,
      attempt: state.attemptIndex,
    });
    return await attempt?.action({ callId: state.callId, name: state.name, kind: state.kind });
  } catch {
    // The action's turn finished without it, so there is no span left to complete.
    return undefined;
  }
}

/** Builds durable `agent.action` spans around eve's runtime dispatch boundary. */
export function createAgentActionInstrumentation(input: {
  readonly tracingFor: (agentName: string | undefined) => AgentTracing;
  readonly attemptFor: (
    scope: InstrumentationAttemptScope,
  ) => Promise<{ attempt: AttemptOperation; agentName?: string } | undefined>;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly stateStore: AgentTraceStateStore;
}): AgentActionInstrumentation {
  const onStarted = async (event: InstrumentationActionStartedEvent): Promise<void> => {
    let state = await input.stateStore.get("action", event.idempotencyKey);
    if (state === undefined) {
      const step = await input.attemptFor(event.scope);
      if (step === undefined) return;
      const operation = await step.attempt.action({
        callId: event.callId,
        kind: event.kind,
        name: event.name,
        arguments: input.recordInputs ? event.input : undefined,
      });
      state = {
        agentName: step.agentName,
        attemptId: event.scope.attemptId,
        attemptIndex: event.scope.attemptIndex,
        callId: event.callId,
        channelAudience: normalizeChannelAudience(event.scope.channelAudience),
        context: { ...operation.reference, isRemote: false },
        kind: event.kind,
        name: event.name,
        rootSessionId: event.scope.rootSessionId,
        sessionId: event.scope.sessionId,
        stepIndex: event.scope.stepIndex,
        turnId: event.scope.turnId,
      };
      await input.stateStore.set("action", event.idempotencyKey, state);
    }
    if (event.isWorkflowTool === true) {
      await input.stateStore.set("anchor", event.idempotencyKey, state);
    }
  };

  const onTerminal = async (event: InstrumentationActionTerminalEvent): Promise<void> => {
    const state = await input.stateStore.get("action", event.idempotencyKey);
    if (state === undefined) return;
    try {
      const operation = await resumeAction(input.tracingFor, state);
      await operation?.complete(actionCompletion(event, input.recordOutputs));
    } finally {
      await input.stateStore.delete("action", event.idempotencyKey);
    }
  };

  async function stateFor(sessionId: string, turnId: string, callId: string) {
    const direct = await input.stateStore.get(
      "action",
      actionIdempotencyKey(sessionId, turnId, callId),
    );
    if (direct !== undefined) return direct;
    return (await input.stateStore.entries("action")).find(
      ([, state]) => state.sessionId === sessionId && state.callId === callId,
    )?.[1];
  }

  return {
    stateFor,
    async contextFor(sessionId, turnId, callId) {
      const state = await stateFor(sessionId, turnId, callId);
      return state === undefined ? undefined : actionContext(state);
    },
    async deleteForSession(sessionId) {
      for (const kind of ["action", "anchor"] as const)
        for (const [key, state] of await input.stateStore.entries(kind))
          if (state.sessionId === sessionId) await input.stateStore.delete(kind, key);
    },
    // A failed attempt closes its actions in the trace tree; only the locators remain.
    async forgetAttempt(scope) {
      for (const [key, state] of await input.stateStore.entries("action"))
        if (state.attemptId === scope.attemptId) await input.stateStore.delete("action", key);
    },
    events: {
      "action.completed": onTerminal,
      "action.failed": onTerminal,
      "action.started": onStarted,
    },
  };
}

function actionCompletion(event: InstrumentationActionTerminalEvent, recordOutputs: boolean) {
  const failed = event.type === "action.failed" || event.output.type === "error";
  return {
    outcome: failed ? "failed" : "completed",
    errorType:
      event.type === "action.failed"
        ? (event.errorCode ?? "Error")
        : event.output.type === "error"
          ? "Error"
          : undefined,
    error:
      event.type === "action.failed"
        ? event.error
        : event.output.type === "error"
          ? event.output.error
          : undefined,
    output:
      recordOutputs && event.type === "action.completed" && event.output.type === "result"
        ? event.output.output
        : undefined,
    usage: event.usage,
    endTimeMs: event.acceptedAtMs,
  };
}

function actionContext(state: AgentActionTraceState): AgentActionContext {
  return {
    context: withChannelAudience(
      trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(state.context)),
      state.channelAudience,
    ),
    spanContext: state.context,
  };
}
