const TOOL_SESSION_ERROR = Symbol.for("eve.tool-session-error");

/**
 * A framework diagnostic raised in a tool session that is safe to return to
 * the caller verbatim. `invokeTool` returns every other unexpected error as a
 * generic message with an error id, and logs the real error under that id.
 */
export class ToolSessionError extends Error {
  readonly [TOOL_SESSION_ERROR] = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ToolSessionError";
  }
}

export function isToolSessionError(error: unknown): error is ToolSessionError {
  return error instanceof Error && Reflect.get(error, TOOL_SESSION_ERROR) === true;
}
