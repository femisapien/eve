import type { ModelMessage } from "ai";

import { createActionResultEvent } from "#protocol/message.js";
import { resolveRuntimeActionResultsForCallIds } from "#runtime/actions/results.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  WorkflowToolCallEntry,
  RuntimeWorkflowTaskRequest,
} from "#shared/action-types.js";
import { markRuntimeWorkflowToolAction } from "#shared/action-types.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import {
  findBlockingWorkflowToolRun,
  removeBlockingWorkflowToolRuns,
} from "#harness/workflow-tool-runs.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import { normalizeToolModelOutput } from "#harness/tool-model-output.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  answeredCallIds,
  isSameStep,
  readTurnState,
  replaceSuspendedStep,
  settleSuspendedStep,
  type SuspendedStep,
  type ToolResultPart,
} from "#harness/turn-state.js";
import { pendingTaskToolCalls } from "#execution/tasks/calls.js";
import { startsTasks } from "#execution/tasks/tool-entry-point.js";
import type {
  HarnessEmitFn,
  HarnessSession,
  HarnessToolMap,
  SessionStateMap,
  StepInput,
} from "#harness/types.js";

/**
 * Outcome of resolving the runtime calls a suspended step waits on.
 */
interface ResolvePendingCoordinationResult {
  readonly messages: ModelMessage[];
  readonly outcome: "continue" | "resolved" | "unresolved";
  readonly session: HarnessSession;
}

/** The suspended step while it waits on calls the runtime runs. */
export function readRuntimeWaitingStep(
  state: SessionStateMap | undefined,
): SuspendedStep | undefined {
  return readTurnState(state).suspended.find((step) => pendingCoordinationCallIds(step).length > 0);
}

/** The workflow runs a suspended step waits on, which the runtime starts. */
export function pendingWorkflowTasks(step: SuspendedStep): readonly RuntimeWorkflowTaskRequest[] {
  const answered = answeredCallIds(step.messages);
  return step.tasks.filter((task) => !answered.has(task.callId));
}

/** Every call without a result a suspended step waits on the runtime for: workflow runs and task tool calls. */
export function pendingCoordinationCallIds(step: SuspendedStep): readonly string[] {
  const taskToolCallIds = pendingTaskToolCalls(step.messages).map((call) => call.callId);
  return [...pendingWorkflowTasks(step).map((request) => request.callId), ...taskToolCallIds];
}

/**
 * Resolves the runtime calls the suspended step waits on.
 *
 * Once every call has its result, the results join the step's response and
 * `action.result` events report them at the step's coordinates. The step
 * commits to history once every call it made has a result; while an approval
 * beside the calls is still open, the response stays withheld.
 */
export async function resolvePendingCoordination(input: {
  readonly emit?: HarnessEmitFn;
  readonly session: HarnessSession;
  readonly stepInput?: StepInput;
  /** Definitions whose `toModelOutput` projects a workflow tool's result for the model. */
  readonly tools?: HarnessToolMap;
}): Promise<ResolvePendingCoordinationResult> {
  const step = readRuntimeWaitingStep(input.session.state);

  if (step === undefined) {
    return {
      messages: [...input.session.history],
      outcome: "continue",
      session: input.session,
    };
  }

  const readyResults = resolveRuntimeActionResultsForCallIds({
    pendingCallIds: pendingCoordinationCallIds(step),
    results: input.stepInput?.runtimeActionResults ?? [],
  });

  if (readyResults === undefined) {
    return {
      messages: [...input.session.history],
      outcome: "unresolved",
      session: input.session,
    };
  }

  let nextSession: HarnessSession = input.session;
  // The session withdrew each finished run's open questions when its outcome arrived.
  for (const result of readyResults) {
    if (result.kind !== "tool-result") continue;
    const record = findBlockingWorkflowToolRun(nextSession.state, result.callId, step.event.turnId);
    if (record === undefined) continue;
    nextSession = removeBlockingWorkflowToolRuns(nextSession, step.event.turnId, record.callId);
  }

  if (input.emit !== undefined) {
    for (const result of readyResults) {
      await input.emit(createActionResultEvent({ result, ...step.event }));
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

  const settled = settleSuspendedStep(nextSession, toolResults);
  const remaining = readTurnState(settled.session.state).suspended.find((candidate) =>
    isSameStep(candidate, step),
  );
  nextSession =
    remaining === undefined
      ? settled.session
      : replaceSuspendedStep(settled.session, remaining, {
          ...remaining,
          tasks: pendingWorkflowTasks(remaining),
        });
  nextSession = {
    ...nextSession,
    history: validateHarnessModelMessages([...nextSession.history, ...settled.commit]),
  };
  return {
    messages: [...nextSession.history],
    outcome: "resolved",
    session: nextSession,
  };
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
