import type { HarnessSession } from "#harness/types.js";

const TURN_CANCELLED_ERROR_NAME = "TurnCancelledError";

/** Terminal outcome of a cancelled turn. */
export class TurnCancelledError extends Error {
  constructor(message = "The turn was cancelled.") {
    super(message);
    this.name = TURN_CANCELLED_ERROR_NAME;
  }
}

/**
 * A turn cancellation raised when the user declines a session-limit
 * continuation prompt. It keeps the canonical cancellation name, so execution
 * settles it through the standard turn-cancellation path.
 */
export class SessionLimitDeclinedError extends TurnCancelledError {
  /**
   * The session once the decline is recorded: the prompt resolved and the
   * turn it cancels opened. The stream already reports both, so the
   * cancellation settles from here rather than withdrawing the prompt again.
   */
  readonly session: HarnessSession | undefined;

  constructor(session?: HarnessSession) {
    super("The user declined a fresh session token budget.");
    this.session = session;
  }
}

/** The {@link SessionLimitDeclinedError} in `error` or its causes, if any. */
export function findSessionLimitDecline(error: unknown): SessionLimitDeclinedError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    if (current instanceof SessionLimitDeclinedError) return current;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** True when the error, or one of its causes, is a {@link TurnCancelledError}. */
export function isTurnCancellation(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ((current as { name?: unknown }).name === TURN_CANCELLED_ERROR_NAME) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/** Throws when the turn signal has aborted. */
export function throwIfTurnAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted !== true) {
    return;
  }
  if (isTurnCancellation(abortSignal.reason)) {
    throw abortSignal.reason;
  }
  throw new TurnCancelledError();
}
