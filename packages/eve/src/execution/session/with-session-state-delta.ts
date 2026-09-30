import { observeSessionState } from "#execution/session-contract-monitor.js";
import type {
  SessionStateDelta,
  SessionStateTransition,
  SessionStateValues,
  WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { diffValue, snapshotValue } from "#shared/value-delta.js";

// Step code only: the workflow body applies deltas through `state-delta.ts`,
// which stays free of the step-side modules this one reaches.

/**
 * Runs a session step's work and returns its result with the session values
 * it produced replaced by their delta from the values the step was given.
 *
 * Workflow replay reads every step's output but no step's input, so a step
 * that returns only what changed keeps both replay and storage from carrying
 * the whole session once per step. The workflow body applies the delta to the
 * values it passed in; see {@link applySessionStateDelta}.
 *
 * The input is snapshotted before `work` runs because step code may edit it
 * in place, as a channel adapter does with its state.
 */
export async function withSessionStateDelta<
  I extends Partial<SessionStateValues>,
  R extends Partial<SessionStateValues>,
>(input: I, work: (input: I) => Promise<R>): Promise<WithSessionStateDelta<R>>;
export async function withSessionStateDelta(
  input: Partial<SessionStateValues>,
  work: (input: Partial<SessionStateValues>) => Promise<Partial<SessionStateValues>>,
): Promise<SessionStateTransition> {
  const base = {
    serializedContext: snapshotValue(input.serializedContext),
    sessionState: snapshotValue(input.sessionState),
  };
  const { serializedContext, sessionState, ...result } = await work(input);
  observeSessionState(sessionState);
  const stateDelta: { -readonly [K in keyof SessionStateDelta]: SessionStateDelta[K] } = {};
  const contextDelta =
    serializedContext === undefined
      ? undefined
      : diffValue(base.serializedContext, serializedContext);
  if (contextDelta !== undefined) stateDelta.serializedContext = contextDelta;
  const sessionDelta =
    sessionState === undefined ? undefined : diffValue(base.sessionState, sessionState);
  if (sessionDelta !== undefined) stateDelta.sessionState = sessionDelta;
  return { ...result, stateDelta };
}
