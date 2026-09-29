import {
  publishSessionEvents,
  publishWrittenSessionEvents,
  writeSessionEventAhead,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import type {
  WorkflowToolRunAgentStartedMessage,
  WorkflowToolRunRef,
} from "#execution/tools/workflow/messages.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import {
  createActionPartialEvent,
  createAgentStartedEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type { JsonValue } from "#shared/json.js";

/** Publishes a workflow tool run's `ctx.report()` update as `action.partial`. */
export async function emitWorkflowToolRunReportStep(
  input: SessionStepState & {
    readonly from: WorkflowToolRunRef;
    readonly update: JsonValue;
  },
): Promise<PublishedSessionEvents> {
  "use step";

  const event = createActionPartialEvent({
    result: createRuntimeToolResultFromValue({
      callId: input.from.callId,
      output: input.update,
      toolName: input.from.toolName,
    }),
    sequence: input.from.sequence,
    stepIndex: input.from.stepIndex,
    turnId: input.from.turnId,
  });
  return await publishSessionEvents(input, [event]);
}

/** Publishes `agent.started` for a session a workflow tool run opened. */
export async function emitAgentStartedStep(
  input: SessionStepState & {
    readonly message: WorkflowToolRunAgentStartedMessage;
  },
): Promise<PublishedSessionEvents> {
  "use step";

  return await publishSessionEvents(input, [agentStartedEvent(input)]);
}

/**
 * Writes `agent.started` while the session's turn step runs, so clients can
 * follow the child at once. Returns the written event when a channel handler
 * or hook subscribes to it; publish it with {@link publishWrittenEventsStep}
 * once the turn step's result is adopted.
 */
export async function writeAgentStartedStep(
  input: SessionStepState & {
    readonly message: WorkflowToolRunAgentStartedMessage;
  },
): Promise<MessageStreamEvent | undefined> {
  "use step";

  return await writeSessionEventAhead(input, agentStartedEvent(input));
}

/** Runs channel handlers and hooks for events written while a turn step ran. */
export async function publishWrittenEventsStep(
  input: SessionStepState & { readonly events: readonly MessageStreamEvent[] },
): Promise<PublishedSessionEvents> {
  "use step";

  return await publishWrittenSessionEvents(input, input.events);
}

function agentStartedEvent(
  input: SessionStepState & { readonly message: WorkflowToolRunAgentStartedMessage },
): UnstampedMessageStreamEvent {
  const { from, session } = input.message;
  return createAgentStartedEvent({
    callId: from.callId,
    name: session.name,
    parentSessionId: input.sessionState.sessionId,
    remote:
      session.kind === "remote"
        ? {
            url: session.url,
            ...(session.resolverId !== undefined && { resolverId: session.resolverId }),
          }
        : undefined,
    sessionId: session.sessionId,
    ...(from.taskId !== undefined && { taskId: from.taskId }),
    turnId: from.turnId,
  });
}
