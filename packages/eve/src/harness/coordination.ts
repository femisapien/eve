import type { ModelMessage } from "ai";

import { createActionResultEvent } from "#protocol/message.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeWorkflowTaskRequest,
  WorkflowToolCallEntry,
} from "#shared/action-types.js";
import { markRuntimeWorkflowToolAction } from "#shared/action-types.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import {
  findBlockingWorkflowToolRun,
  removeBlockingWorkflowToolRuns,
} from "#harness/workflow-tool-runs.js";
import { normalizeToolModelOutput } from "#harness/tool-model-output.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { startsTasks } from "#execution/tasks/tool-entry-point.js";
import type { HeldStep } from "#harness/human-input/index.js";
import type { HarnessEmitFn, HarnessSession, HarnessToolMap } from "#harness/types.js";

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

/** Rejects a batch before any result or side effect can bind ambiguously by call id. */
export function assertUniqueCoordinationCallIds(
  requests: readonly { readonly callId: string }[],
): void {
  const seen = new Set<string>();
  for (const request of requests) {
    if (seen.has(request.callId)) {
      throw new Error(`Coordination batch contains duplicate callId "${request.callId}".`);
    }
    seen.add(request.callId);
  }
}

/**
 * Reads the results of the held step's runtime calls, once every one of them
 * has a result: emits each as `action.result` at the step's coordinates,
 * drops the workflow runs that finished, and returns the tool message that
 * joins the step. Unknown and duplicate results are ignored. Returns
 * `undefined` while some call still runs.
 */
export async function readRuntimeResults(input: {
  readonly emit?: HarnessEmitFn;
  readonly held: HeldStep;
  readonly results: readonly RuntimeActionResult[];
  readonly session: HarnessSession;
  /** Definitions whose `toModelOutput` projects a workflow tool's result for the model. */
  readonly tools?: HarnessToolMap;
  /** The turn a step stored without one runs in. */
  readonly turnId: string;
}): Promise<{ readonly message: ModelMessage; readonly session: HarnessSession } | undefined> {
  const { held } = input;
  const readyResults = resolveRuntimeActionResultsForCallIds({
    pendingCallIds: held.calls
      .filter((call) => call.waitsOn === "runtime")
      .map((call) => call.callId),
    results: input.results,
  });
  if (readyResults === undefined) return undefined;
  const at = held.at.turnId === "" ? { ...held.at, turnId: input.turnId } : held.at;

  let nextSession: HarnessSession = input.session;
  // The session withdrew each finished run's open questions when its outcome arrived.
  for (const result of readyResults) {
    if (result.kind !== "tool-result") continue;
    const record = findBlockingWorkflowToolRun(nextSession.state, result.callId, at.turnId);
    if (record === undefined) continue;
    nextSession = removeBlockingWorkflowToolRuns(nextSession, at.turnId, record.callId);
  }

  if (input.emit !== undefined) {
    for (const result of readyResults) {
      await input.emit(createActionResultEvent({ result, ...at }));
    }
  }

  const toolResults: ToolResultPart[] = [];
  for (const result of readyResults) {
    switch (result.kind) {
      case "load-skill-result":
        toolResults.push({
          output: toToolResultOutput(result),
          toolCallId: result.callId,
          toolName: "load_skill",
          type: "tool-result",
        });
        continue;
      case "subagent-result":
        toolResults.push({
          output: toToolResultOutput(result),
          toolCallId: result.callId,
          toolName: result.subagentName,
          type: "tool-result",
        });
        continue;
      case "tool-result":
        toolResults.push({
          output: await projectToolResultOutput(result, input.tools?.get(result.toolName)),
          toolCallId: result.callId,
          toolName: result.toolName,
          type: "tool-result",
        });
        continue;
    }

    throw new Error(`Unsupported runtime action result kind "${String(result)}".`);
  }
  return { message: { content: toolResults, role: "tool" }, session: nextSession };
}

/** The parts of a model tool call that coordination turns into a runtime request. */
export interface CoordinationToolCall {
  readonly input: unknown;
  readonly toolCallId: string;
  readonly toolName: string;
}

/**
 * Projects one AI SDK tool call into the eve runtime-action contract.
 */
export function createRuntimeActionRequestFromToolCall(input: {
  readonly toolCall: CoordinationToolCall;
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
export function createCoordinationRequestFromToolCall(input: {
  readonly entry: WorkflowToolCallEntry;
  readonly input: JsonObject;
  readonly toolCall: CoordinationToolCall;
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
