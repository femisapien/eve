import type { ModelMessage } from "ai";

import {
  createMessageReceivedEvent,
  createSessionFailedEvent,
  createSessionStartedEvent,
  createSessionWaitingEvent,
  createStepFailedEvent,
  createStepStartedEvent,
  createTurnCancelledEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createTurnStartedEvent,
  type RuntimeIdentity,
  type RuntimeTraceContext,
} from "#protocol/message.js";
import {
  activeTurnId,
  closeTurn,
  eventCoordinates,
  openTurn,
  type TurnState,
} from "#harness/turn-state.js";
import type { HarnessEmitFn, StepInput } from "#harness/types.js";
import type { JsonObject } from "#shared/json.js";

// Every turn and session lifecycle event is projected here, from the
// transition that causes it. Callers never emit these events directly.

/**
 * Opens a turn: `session.started` once, `turn.started`, then
 * `message.received` for the turn's message. Steering re-enters an open turn,
 * keeping its id and step and emitting only the new message.
 */
export async function emitTurnOpened(input: {
  readonly emit: HarnessEmitFn;
  readonly turnState: TurnState;
  readonly messages: readonly ModelMessage[];
  readonly runtimeIdentity?: RuntimeIdentity;
  readonly stepInput: StepInput;
  readonly traceContext?: RuntimeTraceContext;
}): Promise<TurnState> {
  const { emit, turnState } = input;
  const opened = openTurn(turnState);
  const turnId = activeTurnId(opened);
  if (!turnState.started) {
    await emit(
      createSessionStartedEvent({ runtime: input.runtimeIdentity, trace: input.traceContext }),
    );
  }
  if (turnState.turn === undefined) {
    await emit(
      createTurnStartedEvent({ sequence: opened.sequence, trace: input.traceContext, turnId }),
      input.messages,
    );
  }
  if (input.stepInput.message !== undefined) {
    await emit(
      createMessageReceivedEvent({
        message: input.stepInput.message,
        sequence: opened.sequence,
        turnId,
      }),
    );
  }
  return opened;
}

export async function emitStepStarted(
  emit: HarnessEmitFn,
  turnState: TurnState,
  modelId: string,
  messages?: readonly ModelMessage[],
): Promise<void> {
  await emit(createStepStartedEvent({ ...eventCoordinates(turnState), modelId }), messages);
}

/** Every session that settles without ending waits for the next message. */
export async function emitSessionWaiting(emit: HarnessEmitFn): Promise<void> {
  await emit(createSessionWaitingEvent());
}

/** Closes the turn successfully: `turn.completed` → `session.waiting`. */
export async function emitTurnCompleted(
  emit: HarnessEmitFn,
  turnState: TurnState,
  messages: readonly ModelMessage[],
): Promise<TurnState> {
  await emit(
    createTurnCompletedEvent({ sequence: turnState.sequence, turnId: activeTurnId(turnState) }),
    messages,
  );
  await emitSessionWaiting(emit);
  return closeTurn(turnState);
}

/** A user decision, never a failure: `turn.cancelled` → `session.waiting`. */
export async function emitTurnCancelled(
  emit: HarnessEmitFn,
  turnState: TurnState,
): Promise<TurnState> {
  await emit(
    createTurnCancelledEvent({ sequence: turnState.sequence, turnId: activeTurnId(turnState) }),
  );
  await emitSessionWaiting(emit);
  return closeTurn(turnState);
}

export interface TurnFailure {
  readonly code: string;
  readonly details?: JsonObject;
  readonly message: string;
}

/**
 * Closes the turn as failed: `step.failed` → `turn.failed`, then
 * `session.waiting` when the session can take another message, or
 * `session.failed` when it cannot.
 */
export async function emitTurnFailed(
  emit: HarnessEmitFn,
  turnState: TurnState,
  failure: TurnFailure,
  terminal?: { readonly sessionId: string },
): Promise<TurnState> {
  const coordinates = eventCoordinates(turnState);
  await emit(createStepFailedEvent({ ...failure, ...coordinates }));
  await emit(
    createTurnFailedEvent({
      ...failure,
      sequence: coordinates.sequence,
      turnId: coordinates.turnId,
    }),
  );
  if (terminal === undefined) await emitSessionWaiting(emit);
  else await emit(createSessionFailedEvent({ ...failure, sessionId: terminal.sessionId }));
  return closeTurn(turnState);
}
