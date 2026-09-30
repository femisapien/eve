import { sessionProjectionOf, type ConversationState } from "#client/conversation-state.js";
import type { EveDynamicToolPart } from "#client/message-reducer-types.js";
import {
  callStatus,
  type SessionCallStatus,
  type SessionProjection,
} from "#protocol/session-projection.js";

/**
 * Where a tool call stands: `"awaiting-input"` waits on an approval or question; `"rejected"` was
 * denied or not approved; `"cancelled"` was stopped by eve, such as a call that asked for a
 * sign-in or one a cancelled turn cut off; `"interrupted"` was still running when its turn ended,
 * or when the stream stopped.
 */
export type ToolCallStatus = SessionCallStatus;

export interface ToolCallState {
  readonly status: ToolCallStatus;
  /** The call's result, or its latest partial result while running. */
  readonly output?: unknown;
  /** Why the call failed, was rejected, or was stopped, when the stream said. */
  readonly errorText?: string;
}

export interface ToolCallContext {
  /**
   * Whether the session's stream is still delivering events; defaults to `true`. Once it stops,
   * nothing can finish a call whose turn hasn't ended, so the call reads as interrupted.
   */
  readonly streaming?: boolean;
}

/**
 * The state of one tool call: its status from the session projection eve shares with its own
 * activity, plus the output and error text its part carries.
 *
 * A subagent's call that this session shows only because its task passed up an approval for it
 * waits on that approval, then reads as the call of this session whose task asked.
 */
export function toolCallState(
  conversation: ConversationState,
  part: EveDynamicToolPart,
  context: ToolCallContext = {},
): ToolCallState {
  const projection = sessionProjectionOf(conversation);
  const status =
    callStatus(projection, part.toolCallId, context) ??
    passedUpStatus(projection, part, context) ??
    partStatus(part);
  const taskCall = taskCallOf(projection, part.toolCallId);
  switch (status) {
    case "completed":
      return withDetail(status, "output", taskCall?.output ?? partOutput(part));
    case "running":
      return withDetail(status, "output", partOutput(part));
    case "failed":
    case "cancelled":
      return withDetail(
        status,
        "errorText",
        taskCall?.error?.message ?? (part.state === "output-error" ? part.errorText : undefined),
      );
    case "rejected":
      return withDetail(status, "errorText", rejectionText(projection, part));
    default:
      return { status };
  }
}

function withDetail(
  status: ToolCallStatus,
  key: "errorText" | "output",
  value: unknown,
): ToolCallState {
  if (value === undefined) return { status };
  return key === "output" ? { output: value, status } : { errorText: String(value), status };
}

function taskCallOf(projection: SessionProjection, callId: string) {
  const taskId = projection.calls[callId]?.taskId;
  return taskId === undefined ? undefined : projection.tasks[taskId]?.calls[callId];
}

function passedUpStatus(
  projection: SessionProjection,
  part: EveDynamicToolPart,
  context: ToolCallContext,
): ToolCallStatus | undefined {
  const input = Object.values(projection.inputs).findLast(
    (candidate) =>
      candidate.request.action.callId === part.toolCallId &&
      candidate.callId !== undefined &&
      candidate.callId !== part.toolCallId,
  );
  if (input?.callId === undefined) return undefined;
  if (input.status !== "settled") return "awaiting-input";
  if (input.outcome === "cancelled") return "cancelled";
  if (input.outcome !== "approved" && input.response?.optionId !== "approve") return "rejected";
  return callStatus(projection, input.callId, context);
}

/** A part folded by a reducer that kept no lifecycle, such as a custom one, says what it can. */
function partStatus(part: EveDynamicToolPart): ToolCallStatus {
  switch (part.state) {
    case "approval-requested":
      return "awaiting-input";
    case "output-available":
      return part.partial === true ? "running" : "completed";
    case "output-error":
      return "failed";
    case "output-denied":
      return "rejected";
    case "approval-responded":
      return part.approval.approved === false ? "rejected" : "running";
    default:
      return "running";
  }
}

function partOutput(part: EveDynamicToolPart): unknown {
  return part.state === "output-available" ? part.output : undefined;
}

function rejectionText(projection: SessionProjection, part: EveDynamicToolPart): unknown {
  if (part.state === "output-denied" || part.state === "approval-responded") {
    if (part.approval.reason !== undefined) return part.approval.reason;
  }
  const requestId = projection.calls[part.toolCallId]?.requestId ?? part.approval?.id;
  return requestId === undefined ? undefined : projection.inputs[requestId]?.response?.text;
}
