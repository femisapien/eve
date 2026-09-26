import {
  readDurableSession,
  replaceDurableSessionSnapshot,
  type DurableSession,
  type DurableSessionState,
} from "#execution/durable-session-store.js";
import type { TaskHardStopWorkflowInput } from "#execution/tasks/hard-stop-workflow.js";
import {
  cancelTask,
  finishTaskRun,
  markTaskRunStarted,
  nextHardStopDue,
  readTaskTable,
  setHardStopAt,
  settleTaskCall,
  takeOverdueRuns,
  writeTaskTable,
  type TaskCallOutcome,
  type TaskRunAddress,
  type TaskSettlement,
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
import {
  startWorkflowOnCurrentDeployment,
  taskHardStopWorkflowReference,
} from "#execution/workflow-runtime.js";
import { clearProxyInputRequestsWhere } from "#harness/proxy-input-requests.js";
import { cancelRun, getWorld, resumeHook } from "#internal/workflow/runtime.js";
import { createTaskSettledEvent, type TaskSettledStreamEvent } from "#protocol/message.js";

/** The messages a task's run sends that change its record. */
export type TaskRunMessage = Extract<
  WorkflowToolRunMessage,
  { readonly kind: "outcome" | "started" }
>;

interface TaskStepResult {
  readonly sessionState: DurableSessionState;
}

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
  const settlements: TaskSettlement[] = [];
  switch (message.kind) {
    case "started": {
      const started = markTaskRunStarted(table, taskId, message.from.runId);
      table = started.table;
      if (started.heldCancel !== undefined) await sendTaskCancel(started.heldCancel);
      break;
    }
    case "outcome": {
      const settled = settleTaskCall(table, {
        callId: message.from.callId,
        outcome: toCallOutcome(message),
        taskId,
      });
      if (settled.settlement !== undefined) settlements.push(settled.settlement);
      table = finishTaskRun(settled.table, taskId, message.from.runId);
      session = forgetRunQuestions(session, message.from.runId);
      break;
    }
  }
  return await publishSessionEvents(
    { ...input, sessionState: saveTable(input.sessionState, session, table) },
    settlements.map(taskSettledEvent),
  );
}

/**
 * Cancels tasks: their calls settle as cancelled, their runs are told to
 * stop, and the sleeper is armed to hard-stop any run that doesn't confirm.
 */
export async function cancelTasksStep(
  input: SessionStepState & {
    readonly inbox: string;
    readonly taskIds: readonly string[];
  },
): Promise<PublishedSessionEvents> {
  "use step";

  const session = readDurableSession(input.sessionState);
  const now = Date.now();
  let table = readTaskTable(session.state);
  const settlements: TaskSettlement[] = [];
  for (const taskId of input.taskIds) {
    const cancelled = cancelTask(table, taskId, now);
    table = cancelled.table;
    settlements.push(...cancelled.settlements);
    if (cancelled.sendCancel !== undefined) await sendTaskCancel(cancelled.sendCancel);
  }
  table = await armHardStop(table, input.inbox);
  return await publishSessionEvents(
    { ...input, sessionState: saveTable(input.sessionState, session, table) },
    settlements.map(taskSettledEvent),
  );
}

/** Hard-stops every cancelled run whose confirmation is overdue, then re-arms the sleeper. */
export async function hardStopOverdueTasksStep(input: {
  readonly inbox: string;
  readonly sessionState: DurableSessionState;
}): Promise<TaskStepResult> {
  "use step";

  let session = readDurableSession(input.sessionState);
  const overdue = takeOverdueRuns(readTaskTable(session.state), Date.now());
  const world = await getWorld();
  for (const run of overdue.runs) {
    await ignoreGoneTarget(
      cancelRun(world, run.runId, { cancelReason: "The task was cancelled." }),
    );
    session = forgetRunQuestions(session, run.runId);
  }
  const table = await armHardStop(setHardStopAt(overdue.table, undefined), input.inbox);
  return { sessionState: saveTable(input.sessionState, session, table) };
}

/** The `task.settled` event for one settled call. */
function taskSettledEvent(settlement: TaskSettlement): TaskSettledStreamEvent {
  const base = {
    callId: settlement.callId,
    taskId: settlement.taskId,
    turnId: settlement.turnId,
  };
  switch (settlement.status) {
    case "completed":
      return createTaskSettledEvent({ ...base, output: settlement.output, status: "completed" });
    case "failed":
      return createTaskSettledEvent({
        ...base,
        error: { message: settlement.error },
        status: "failed",
      });
    case "cancelled":
      return createTaskSettledEvent({ ...base, status: "cancelled" });
  }
}

/** Starts the session's one sleeper for the earliest pending confirmation, unless one is armed. */
async function armHardStop(table: TaskTable, inbox: string): Promise<TaskTable> {
  const dueAt = nextHardStopDue(table);
  if (dueAt === undefined || table.hardStopAt !== undefined) return table;
  const input: TaskHardStopWorkflowInput = { dueAt, inbox };
  await startWorkflowOnCurrentDeployment(taskHardStopWorkflowReference, [input]);
  return setHardStopAt(table, dueAt);
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

function toCallOutcome(message: WorkflowToolRunOutcomeMessage): TaskCallOutcome {
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
