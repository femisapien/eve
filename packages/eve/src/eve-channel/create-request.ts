import type { UserContent } from "ai";

import type {
  ActivityObserverConfig,
  SessionCallback,
  SessionCapabilities,
} from "#channel/types.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

export interface ParsedCreateBody {
  activityObserver?: ActivityObserverConfig;
  callback?: SessionCallback;
  capabilities?: SessionCapabilities;
  message?: string | UserContent;
  context?: readonly string[];
  operationId?: string;
  outputSchema?: JsonObject;
  sessionContext?: JsonObject;
}

/** Enforces the fields that only make sense when creation also starts a turn. */
export function validateMessageFreeCreate(input: {
  readonly activityObserver: ActivityObserverConfig | undefined;
  readonly callback: SessionCallback | undefined;
  readonly hasClientContext: boolean;
  readonly hasMessageField: boolean;
  readonly message: string | UserContent | undefined;
  readonly outputSchema: JsonObject | undefined;
}): Response | undefined {
  if (input.hasMessageField && input.message === undefined) {
    return Response.json(
      { error: "Expected 'message' to be non-empty when provided.", ok: false },
      { status: 400 },
    );
  }
  if (input.message !== undefined) return undefined;
  if (
    input.hasClientContext ||
    input.callback !== undefined ||
    input.activityObserver !== undefined ||
    input.outputSchema !== undefined
  ) {
    return Response.json(
      {
        error:
          "Creating a session without a message does not accept 'clientContext', 'callback', 'activityObserver', or 'outputSchema'.",
        ok: false,
      },
      { status: 400 },
    );
  }
  return undefined;
}

export function parseCapabilitiesField(value: unknown): SessionCapabilities | Response | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Response.json(
      { error: "Expected 'capabilities' to be an object.", ok: false },
      { status: 400 },
    );
  }

  const keys = Object.keys(value);
  const requestInput = Reflect.get(value, "requestInput");
  if (
    keys.some((key) => key !== "requestInput") ||
    (requestInput !== undefined && typeof requestInput !== "boolean")
  ) {
    return Response.json(
      { error: "Expected 'capabilities.requestInput' to be a boolean when provided.", ok: false },
      { status: 400 },
    );
  }

  return requestInput === undefined ? {} : { requestInput };
}

export function parseSessionContextField(value: unknown): JsonObject | Response | undefined {
  if (value === undefined) return undefined;
  try {
    return parseJsonObject(value);
  } catch {
    return Response.json(
      { error: "Expected 'sessionContext' to be a JSON object.", ok: false },
      { status: 400 },
    );
  }
}
