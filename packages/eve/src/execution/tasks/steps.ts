import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import {
  cancelTask,
  finishTaskRun,
  markTaskRunStarted,
  readTaskTable,
  settleTaskCall,
  writeTaskTable,
  type TaskCall,
  type TaskOutcome,
  type TaskRunAddress,
  type TaskTable,
} from "#execution/tasks/table.js";
import { isTaskWorkflowTargetGone } from "#execution/tasks/workflow-target.js";
import {
  publishSessionEvents,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import type {
  WorkflowToolRunControlMessage,
  WorkflowToolRunMessage,
  WorkflowToolRunOutcomeMessage,
} from "#execution/tools/workflow/messages.js";
import { workflowToolRunFailureOutput } from "#execution/tools/workflow/owner-inbox.js";
import { clearProxyInputRequestsWhere } from "#harness/proxy-input-requests.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { createTaskSettledEvent, type TaskSettledStreamEvent } from "#protocol/message.js";

/** The messages a task's run sends that change its record. */
export type TaskRunMessage = Extract<
  WorkflowToolRunMessage,
  { readonly kind: "outcome" | "started" }
>;

const TASK_CANCEL_COMMAND: WorkflowToolRunControlMessage = {
  kind: "cancel",
  reason: "The task was cancelled.",
};

/** Applies one message from a task's run: started, or the run's outcome. */
export async function applyTaskRunMessageStep(
  input: SessionStepState & { readonly message: TaskRunMessage },
): Promise<PublishedSessionEvents> {
  "use step";

  const { message } = input;
  const taskId = message.from.taskId;
  let session = readDurableSession(input.sessionState);
  if (taskId === undefined) {
    return { serializedContext: input.serializedContext, sessionState: input.sessionState };
  }
  let table = readTaskTable(session.state);
  const events: TaskSettledStreamEvent[] = [];
  switch (message.kind) {
    case "started": {
      const started = markTaskRunStarted(table, taskId, message.from.runId);
      table = started.table;
      if (started.heldCancel !== undefined) await sendTaskCancel(started.heldCancel);
      break;
    }
    case "outcome": {
      const outcome = toOutcome(message);
      const settled = settleTaskCall(table, { callId: message.from.callId, outcome, taskId });
      events.push(...settled.settled.map((call) => taskSettledEvent(taskId, call, outcome)));
      table = finishTaskRun(settled.table, taskId, message.from.runId);
      session = forgetRunQuestions(session, message.from.runId);
      break;
    }
  }
  return await publishSessionEvents(
    { ...input, sessionState: saveTable(input.sessionState, session, table) },
    events,
  );
}

/**
 * Cancels tasks: their calls settle as cancelled and their runs are told to
 * stop. A run ends itself within its cleanup deadline and reports cancelled.
 */
export async function cancelTasksStep(
  input: SessionStepState & { readonly taskIds: readonly string[] },
): Promise<PublishedSessionEvents> {
  "use step";

  const session = readDurableSession(input.sessionState);
  let table = readTaskTable(session.state);
  const events: TaskSettledStreamEvent[] = [];
  for (const taskId of input.taskIds) {
    const cancelled = cancelTask(table, taskId);
    table = cancelled.table;
    events.push(...cancelled.settled.map((call) => taskSettledEvent(taskId, call, CANCELLED)));
    if (cancelled.sendCancel !== undefined) await sendTaskCancel(cancelled.sendCancel);
  }
  return await publishSessionEvents(
    { ...input, sessionState: saveTable(input.sessionState, session, table) },
    events,
  );
}

const CANCELLED: TaskOutcome = { status: "cancelled" };

/** The `task.settled` event for one settled call. */
function taskSettledEvent(
  taskId: string,
  call: TaskCall,
  outcome: TaskOutcome,
): TaskSettledStreamEvent {
  const base = { callId: call.callId, taskId, turnId: call.turnId };
  switch (outcome.status) {
    case "completed":
      return createTaskSettledEvent({ ...base, output: outcome.output, status: "completed" });
    case "failed":
      return createTaskSettledEvent({
        ...base,
        error: { message: outcome.error },
        status: "failed",
      });
    case "cancelled":
      return createTaskSettledEvent({ ...base, status: "cancelled" });
  }
}

async function sendTaskCancel(run: TaskRunAddress): Promise<void> {
  await ignoreGoneTarget(resumeHook(run.hookToken, TASK_CANCEL_COMMAND));
}

async function ignoreGoneTarget(pending: Promise<unknown>): Promise<void> {
  try {
    await pending;
  } catch (error) {
    if (!isTaskWorkflowTargetGone(error)) throw error;
  }
}

function toOutcome(message: WorkflowToolRunOutcomeMessage): TaskOutcome {
  switch (message.result.status) {
    case "completed":
      return { output: message.result.output, status: "completed" };
    case "failed":
      return { error: failureMessage(message), status: "failed" };
    case "cancelled":
      return { status: "cancelled" };
  }
}

function failureMessage(message: WorkflowToolRunOutcomeMessage): string {
  const output = workflowToolRunFailureOutput(message);
  if (typeof output === "string") return output;
  const described =
    typeof output === "object" && output !== null ? Reflect.get(output, "message") : undefined;
  return typeof described === "string" ? described : JSON.stringify(output);
}

/** A finished run can no longer take answers, so its unanswered questions are dropped. */
function forgetRunQuestions(session: DurableSession, runId: string): DurableSession {
  return clearProxyInputRequestsWhere(session, (route) => route.workflowAsk?.runId === runId);
}

function saveTable(
  state: DurableSessionState,
  session: DurableSession,
  table: TaskTable,
): DurableSessionState {
  return replaceDurableSessionSnapshot({ session: writeTaskTable(session, table), state });
}
