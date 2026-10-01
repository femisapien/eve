import { commitCallEntry, commitGatedCall, isTaskTool } from "#execution/tasks/model-step.js";
import { GATED_TOOL_CALL_WORKFLOW_ID } from "#execution/tools/gate/reference.js";
import { toolCallDisplayName } from "#execution/tools/connection-target.js";
import {
  createCoordinationRequestFromToolCall,
  resolveToolCallInputObject,
  type CoordinationToolCall,
} from "#harness/coordination.js";
import type { HarnessSession, HarnessToolMap } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

/**
 * Turns a step's deferred calls into workflow runs, committing a task record
 * for each call that starts a task. A gated call, one that waits for a
 * person's approval, always starts a task whose run asks first. Task tool
 * calls stay in the response alone: the session reads them from there.
 */
export function collectDeferredCalls(input: {
  readonly gatedCallIds: ReadonlySet<string>;
  readonly session: HarnessSession;
  readonly toolCalls: readonly CoordinationToolCall[];
  readonly tools: HarnessToolMap;
  readonly turnId: string;
}): {
  readonly session: HarnessSession;
  readonly workflowRequests: readonly RuntimeWorkflowTaskRequest[];
} {
  let { session } = input;
  const workflowRequests: RuntimeWorkflowTaskRequest[] = [];
  for (const toolCall of input.toolCalls) {
    const definition = input.tools.get(toolCall.toolName);
    if (isTaskTool(definition)) continue;
    const gated = input.gatedCallIds.has(toolCall.toolCallId);
    const call = {
      callId: toolCall.toolCallId,
      definition,
      input: resolveToolCallInputObject(toolCall.input, {
        callId: toolCall.toolCallId,
        toolName: toolCall.toolName,
      }),
      toolName: toolCall.toolName,
      turnId: input.turnId,
    };
    const committed = gated ? commitGatedCall(session, call) : commitCallEntry(session, call);
    session = committed.session;
    workflowRequests.push(
      gated
        ? {
            approval: {
              key: definition?.approvalKey?.(call.input) ?? call.toolName,
              prompt: `Approve ${toolCallDisplayName(call.toolName, call.input)}?`,
            },
            callId: call.callId,
            entry: committed.entry,
            executeInput:
              definition?.workflowId === undefined
                ? undefined
                : definition.executeInput?.(committed.input),
            input: committed.input,
            kind: "workflow-task",
            toolName: call.toolName,
            workflowId: definition?.workflowId ?? GATED_TOOL_CALL_WORKFLOW_ID,
          }
        : createCoordinationRequestFromToolCall({
            entry: committed.entry,
            input: committed.input,
            toolCall,
            tools: input.tools,
          }),
    );
  }
  return { session, workflowRequests };
}
