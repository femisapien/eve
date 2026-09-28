/**
 * Calls to the task tools. They defer out of the model step like
 * workflow tool calls; the session answers them instead of a workflow run.
 */
export type TaskToolCall =
  | { readonly callId: string; readonly kind: "task_wait"; readonly timeoutMs?: number }
  | { readonly callId: string; readonly kind: "task_cancel"; readonly taskId: string };

export const TASK_WAIT_TOOL_NAME = "task_wait";
export const TASK_CANCEL_TOOL_NAME = "task_cancel";

/** The task tools' names; authored tools cannot use them. */
export const TASK_TOOL_NAMES: readonly string[] = [TASK_WAIT_TOOL_NAME, TASK_CANCEL_TOOL_NAME];

/** Why a `task_wait` call, or a held turn, stopped waiting. */
export type TaskWaitResult =
  | {
      readonly status: "settled";
      /** Tasks whose results follow; both lists are empty when nothing was working. */
      readonly settled: readonly string[];
      readonly working: readonly string[];
    }
  | { readonly status: "timeout" | "interrupt"; readonly working: readonly string[] };

export type TaskCancelResult = { readonly status: "cancelled" | "already_finished" };
