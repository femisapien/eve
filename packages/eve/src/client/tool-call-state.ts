import type { ConversationState, ConversationTaskCall } from "#client/conversation-state.js";
import type { EveDynamicToolPart } from "#client/message-reducer-types.js";

/**
 * Where a tool call stands. `"awaiting-input"` waits on an approval or question; `"interrupted"`
 * was still running when the turn that runs it ended.
 */
export type ToolCallStatus =
  | "running"
  | "awaiting-input"
  | "done"
  | "failed"
  | "denied"
  | "cancelled"
  | "interrupted";

export interface ToolCallState {
  readonly status: ToolCallStatus;
  /** The call's result, or its latest partial result while running. */
  readonly output?: unknown;
  /** Why the call failed or was denied, when the stream said. */
  readonly errorText?: string;
}

export interface ToolCallContext {
  /** The turn of the message that holds the part. */
  readonly turnId: string | undefined;
  /**
   * Whether the session's stream is still delivering events; defaults to `true`. Once it stops,
   * nothing can finish a call whose turn hasn't ended, so the call reads as interrupted.
   */
  readonly streaming?: boolean;
}

/**
 * The state of one tool call, from its part and the conversation around it.
 *
 * A call that started a task runs until its task settles, even after its turn ends. An approved or
 * answered call runs in the turn that starts after the request settles, since asking ends the turn.
 * Any other call that is still running when its turn ends is interrupted, or cancelled when the
 * turn was.
 */
export function toolCallState(
  conversation: ConversationState,
  part: EveDynamicToolPart,
  context: ToolCallContext,
): ToolCallState {
  const taskId = part.toolMetadata?.eve?.taskId;
  const call =
    taskId === undefined ? undefined : conversation.tasks[taskId]?.calls[part.toolCallId];
  if (call !== undefined) return taskCallState(call);

  const state = partState(part, conversation);
  if (state.status !== "running") return state;
  const runsIn =
    part.approval === undefined
      ? context.turnId
      : conversation.inputs[part.approval.id]?.resumeTurnId;
  switch (turnLiveness(conversation, runsIn)) {
    case "open":
      return context.streaming === false ? { status: "interrupted" } : state;
    case "cancelled":
      return { status: "cancelled" };
    case "closed":
      return { status: "interrupted" };
  }
}

function taskCallState(call: ConversationTaskCall): ToolCallState {
  switch (call.status) {
    case "working":
      return { status: "running" };
    case "completed":
      return { output: call.output, status: "done" };
    case "failed":
      return { errorText: call.error?.message, status: "failed" };
    case "cancelled":
      return { status: "cancelled" };
  }
}

function partState(part: EveDynamicToolPart, conversation: ConversationState): ToolCallState {
  switch (part.state) {
    case "approval-requested": {
      const input = conversation.inputs[part.approval.id];
      if (input === undefined || input.status === "open") return { status: "awaiting-input" };
      if (input.request.kind !== "tool-approval") return { status: "running" };
      return input.response?.optionId === "approve" || input.outcome === "approved"
        ? { status: "running" }
        : { errorText: input.response?.text, status: "denied" };
    }
    case "approval-responded":
      return part.approval.approved === false
        ? { errorText: part.approval.reason, status: "denied" }
        : { status: "running" };
    case "output-available":
      return part.partial === true
        ? { output: part.output, status: "running" }
        : { output: part.output, status: "done" };
    case "output-error":
      return { errorText: part.errorText, status: "failed" };
    case "output-denied":
      return { errorText: part.approval.reason, status: "denied" };
    default:
      return { status: "running" };
  }
}

/** A turn the conversation hasn't seen yet can't have ended. */
function turnLiveness(
  conversation: ConversationState,
  turnId: string | undefined,
): "open" | "cancelled" | "closed" {
  const turn = turnId === undefined ? undefined : conversation.turns[turnId];
  if (turn === undefined) return "open";
  if (turn.status === "active") return conversation.activeTurnId === turnId ? "open" : "closed";
  return turn.status === "cancelled" ? "cancelled" : "closed";
}
