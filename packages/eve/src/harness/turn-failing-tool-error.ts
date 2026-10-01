const TURN_FAILING_TOOL_ERROR_NAME = "TurnFailingToolError";

/**
 * Thrown by a tool's `execute` to fail the turn. Any other error becomes a
 * tool-error result the model reads and can work around; this one ends the
 * turn as failed with `code` and `message`, and the session waits for the
 * next message.
 */
export class TurnFailingToolError extends Error {
  readonly code: string;

  constructor(input: { readonly code: string; readonly message: string }) {
    super(input.message);
    this.name = TURN_FAILING_TOOL_ERROR_NAME;
    this.code = input.code;
  }
}

/** Returns the first error in a step's tool errors that fails the turn. */
export function findTurnFailingToolError(
  content: readonly { readonly type: string; readonly error?: unknown }[] | undefined,
): TurnFailingToolError | undefined {
  for (const part of content ?? []) {
    if (part.type === "tool-error" && isTurnFailingToolError(part.error)) return part.error;
  }
  return undefined;
}

// Matched by name so the check holds across separately bundled copies of eve.
function isTurnFailingToolError(error: unknown): error is TurnFailingToolError {
  return (
    error instanceof Error &&
    error.name === TURN_FAILING_TOOL_ERROR_NAME &&
    typeof (error as { code?: unknown }).code === "string"
  );
}
