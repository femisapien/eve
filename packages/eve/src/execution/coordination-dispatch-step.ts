/** Starts workflow-tool runs for pending coordination. */

import {
  prepareCoordinationDispatch,
  type CoordinationDispatchInput,
  type CoordinationDispatchResult,
} from "#execution/coordination-dispatch-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { publishSessionEvents } from "#execution/publish-session-events.js";
import { startWorkflowTask } from "#execution/tools/workflow/start.js";
import { startTaskRun } from "#execution/tasks/start.js";
import { captureAgentSessionContext } from "#execution/agent-sessions/context.js";
import type { TaskStartedStreamEvent } from "#protocol/message.js";
import type { RuntimeActionResult } from "#shared/action-types.js";

type CoordinationDispatchStepInput = CoordinationDispatchInput & {
  readonly action: "park";
};

export async function dispatchCoordinationStep(
  input: CoordinationDispatchStepInput,
): Promise<CoordinationDispatchResult> {
  "use step";

  const prepared = await prepareCoordinationDispatch({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  if (prepared === undefined) {
    return {
      results: [],
      serializedContext: input.serializedContext,
      sessionState: input.sessionState,
    };
  }

  const { batch, session } = prepared;
  let nextSession = session;
  const results: RuntimeActionResult[] = [];
  const started: TaskStartedStreamEvent[] = [];

  for (const task of prepared.plan) {
    const start = {
      agentContext: captureAgentSessionContext(prepared, task.callId),
      agents: prepared.workflowAgents,
      auth: prepared.auth,
      batchEvent: batch.event,
      initiatorAuth: prepared.initiatorAuth,
      owner: input.workflowToolRunOwner,
      parentSession: prepared.parentSession,
      session: nextSession,
      task,
    };
    if (task.entry.entryPoint === "task") {
      const run = await startTaskRun({ ...start, taskId: task.entry.taskId });
      nextSession = run.session;
      results.push(run.result);
      if (run.started !== undefined) started.push(run.started);
    } else {
      const run = await startWorkflowTask(start);
      nextSession = run.session;
      if (run.result !== undefined) results.push(run.result);
    }
  }

  const published = await publishSessionEvents(
    {
      serializedContext: input.serializedContext,
      sessionState:
        nextSession === session
          ? prepared.sessionState
          : createDurableSessionState({ session: nextSession }),
      sessionWritable: input.sessionWritable,
    },
    started,
  );
  return { results, ...published };
}
