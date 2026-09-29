import type { ModelMessage } from "ai";

import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeWorkflowTaskRequest,
  WorkflowToolCallEntry,
} from "#shared/action-types.js";
import { markRuntimeWorkflowToolAction } from "#shared/action-types.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { normalizeToolModelOutput } from "#harness/tool-model-output.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { startsTasks } from "#execution/tasks/tool-entry-point.js";
import type { HarnessToolMap } from "#harness/types.js";

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

/** Projects a runtime action result into the tool result the model reads. */
export async function runtimeResultToToolResultPart(
  result: RuntimeActionResult,
  tools: HarnessToolMap | undefined,
): Promise<ToolResultPart> {
  switch (result.kind) {
    case "load-skill-result":
      return {
        output: toToolResultOutput(result),
        toolCallId: result.callId,
        toolName: "load_skill",
        type: "tool-result",
      };
    case "subagent-result":
      return {
        output: toToolResultOutput(result),
        toolCallId: result.callId,
        toolName: result.subagentName,
        type: "tool-result",
      };
    case "tool-result":
      return {
        output: await projectToolResultOutput(result, tools?.get(result.toolName)),
        toolCallId: result.callId,
        toolName: result.toolName,
        type: "tool-result",
      };
  }
  throw new Error(`Unsupported runtime action result kind "${String(result)}".`);
}

/** The parts of a model tool call the runtime turns into a request. */
export interface ModelToolCall {
  readonly input: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

/**
 * Projects one AI SDK tool call into the eve runtime-action contract.
 */
export function createRuntimeActionRequestFromToolCall(input: {
  readonly toolCall: ModelToolCall;
  readonly tools: HarnessToolMap;
}): RuntimeActionRequest {
  const definition = input.tools.get(input.toolCall.toolName);
  const toolInput = resolveToolCallInputObject(input.toolCall.input, {
    callId: input.toolCall.toolCallId,
    toolName: input.toolCall.toolName,
  });
  if (definition?.frameworkAction === "load-skill") {
    return { callId: input.toolCall.toolCallId, input: toolInput, kind: "load-skill" };
  }
  const action: RuntimeActionRequest = {
    callId: input.toolCall.toolCallId,
    input: toolInput,
    kind: "tool-call",
    toolName: input.toolCall.toolName,
  };
  return definition?.workflowId === undefined ? action : markRuntimeWorkflowToolAction(action);
}

/**
 * Projects one deferred harness tool call into a workflow run request. The
 * input is the tool's own, without anything eve added to its model input.
 */
export function createWorkflowTaskRequestFromToolCall(input: {
  readonly entry: WorkflowToolCallEntry;
  readonly input: JsonObject;
  readonly toolCall: ModelToolCall;
  readonly tools: HarnessToolMap;
}): RuntimeWorkflowTaskRequest {
  const definition = input.tools.get(input.toolCall.toolName);
  if (definition?.workflowId === undefined) {
    throw new Error(`Deferred tool "${input.toolCall.toolName}" has no workflow.`);
  }
  return {
    callId: input.toolCall.toolCallId,
    entry: input.entry,
    executeInput: definition.executeInput?.(input.input),
    input: input.input,
    kind: "workflow-task",
    toolName: input.toolCall.toolName,
    workflowId: definition.workflowId,
  };
}

/**
 * Coerces an AI SDK tool-call `input` into the runtime-action `JsonObject`
 * contract, throwing a `TypeError` (with the original as `cause`) that names
 * the offending tool when the payload is not a JSON object.
 *
 * String inputs are parsed as JSON first: the model protocol carries tool
 * arguments as text, and provider-executed tool calls can surface that raw
 * string — or an empty string when the model sends no arguments.
 */
export function resolveToolCallInputObject(
  value: unknown,
  context: { readonly callId: string; readonly toolName: string },
): JsonObject {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value === "string" && value.trim() === "") {
    return {};
  }

  try {
    return parseJsonObject(typeof value === "string" ? parseJsonStringInput(value) : value);
  } catch (error) {
    // This module is bundled into the workflow driver body, which cannot
    // import the logger, so enrich the error (and keep the original as
    // `cause`) for whatever catch site does the logging.
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(
      `Failed to parse tool-call arguments for "${context.toolName}" (${context.callId}): ${detail}`,
      { cause: error },
    );
  }
}

function parseJsonStringInput(value: string): unknown {
  return JSON.parse(value);
}

/** Errors bypass `toModelOutput`, as they do for local execution. */
async function projectToolResultOutput(
  result: Extract<RuntimeActionResult, { kind: "tool-result" }>,
  definition: HarnessToolDefinition | undefined,
): Promise<ToolResultPart["output"]> {
  // A task tool's call result is its receipt; `toModelOutput` projects the task's result.
  if (
    result.isError === true ||
    definition?.toModelOutput === undefined ||
    startsTasks(definition)
  ) {
    return toToolResultOutput(result);
  }
  return normalizeToolModelOutput({
    output: await definition.toModelOutput(result.output),
    toolCallId: result.callId,
    toolName: result.toolName,
  });
}

function toToolResultOutput(result: RuntimeActionResult): ToolResultPart["output"] {
  if (typeof result.output === "string") {
    if (result.isError === true) {
      return {
        type: "error-text",
        value: result.output,
      };
    }

    return {
      type: "text",
      value: result.output,
    };
  }

  if (result.isError === true) {
    return {
      type: "error-json",
      value: toMutableJsonValue(result.output),
    };
  }

  return {
    type: "json",
    value: toMutableJsonValue(result.output),
  };
}

function toMutableJsonValue(value: RuntimeActionResult["output"]): MutableJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toMutableJsonValue(item));
  }

  const next: Record<string, MutableJsonValue> = {};

  for (const [key, item] of Object.entries(value)) {
    next[key] = toMutableJsonValue(item);
  }

  return next;
}

type MutableJsonValue =
  | null
  | boolean
  | number
  | string
  | MutableJsonValue[]
  | { [key: string]: MutableJsonValue };
