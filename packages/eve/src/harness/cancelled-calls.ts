import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { CANCELLED_CALL_RESULT, type EventCoordinates } from "#harness/turn-state.js";
import {
  createActionResultEvent,
  type ActionResultError,
  type ActionResultStreamEvent,
} from "#protocol/message.js";

/** A call that asked for a sign-in leaves history; the agent calls the tool again after it. */
export const SIGN_IN_REQUIRED: ActionResultError = {
  code: "AUTHORIZATION_REQUIRED",
  message: "The call needs a sign-in. The agent can call the tool again once it completes.",
};

export const TURN_CANCELLED: ActionResultError = {
  code: "TURN_CANCELLED",
  message: CANCELLED_CALL_RESULT,
};

export const CONTEXT_CLEARED: ActionResultError = {
  code: "CONTEXT_CLEARED",
  message: "The conversation was cleared before this call finished.",
};

/**
 * The `cancelled` result of a call eve stopped before it produced a result, so
 * no reader shows an announced call running after eve gave up on it.
 */
export function createCancelledCallEvent(input: {
  readonly callId: string;
  readonly toolName: string;
  readonly reason: ActionResultError;
  readonly coordinates: EventCoordinates;
}): ActionResultStreamEvent {
  const { coordinates, reason } = input;
  return createActionResultEvent({
    cancelled: reason,
    result: createRuntimeToolResultFromValue({
      callId: input.callId,
      isError: true,
      output: { code: reason.code, message: reason.message },
      toolName: input.toolName,
    }),
    sequence: coordinates.sequence,
    stepIndex: coordinates.stepIndex,
    turnId: coordinates.turnId,
  });
}
