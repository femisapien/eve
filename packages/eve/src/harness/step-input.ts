import { resolveTextToResponses } from "#channel/resolve-text.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import type { StepInput } from "#harness/types.js";
import { attachClientContext, readClientContext } from "#internal/client-context.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

/** A message or responses: the input a person delivered. */
export function hasStepInput(input: StepInput | undefined): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.inputResponses?.length ?? 0) > 0;
}

/** Input the model reads as the turn's own: a message, context, or a schema. */
export function hasTurnInput(input: StepInput | undefined): boolean {
  if (input === undefined) return false;
  return (
    input.message !== undefined ||
    (input.context?.length ?? 0) > 0 ||
    readClientContext(input) !== undefined ||
    input.outputSchema !== undefined
  );
}

export function hasAnyStepInput(input: StepInput | undefined): boolean {
  return (
    hasTurnInput(input) ||
    (input?.inputResponses?.length ?? 0) > 0 ||
    (input?.attributedInputResponses?.length ?? 0) > 0
  );
}

/** Joins held input with a later delivery, keeping what only the later one carries. */
export function mergeStepInputs(
  earlier: StepInput | undefined,
  later: StepInput | undefined,
): StepInput | undefined {
  if (earlier === undefined) return later;
  if (later === undefined) return earlier;
  const merged: { -readonly [K in keyof StepInput]: StepInput[K] } = coalesceTurnInputs(
    earlier,
    later,
  );
  const attributed = [
    ...(earlier.attributedInputResponses ?? []),
    ...(later.attributedInputResponses ?? []),
  ];
  if (attributed.length > 0) merged.attributedInputResponses = attributed;
  if (later.runtimeActionResults !== undefined) {
    merged.runtimeActionResults = later.runtimeActionResults;
  }
  const messageAuth = later.messageAuth !== undefined ? later.messageAuth : earlier.messageAuth;
  if (messageAuth !== undefined) merged.messageAuth = messageAuth;
  return merged;
}

export function withoutRuntimeResults(input: StepInput | undefined): StepInput | undefined {
  if (input?.runtimeActionResults === undefined) return input;
  const { runtimeActionResults: _results, ...rest } = input;
  return attachClientContext(rest, readClientContext(input));
}

/** Removes what the model would read as the turn's own input. */
export function withoutTurnInput(input: StepInput | undefined): StepInput | undefined {
  if (input === undefined) return undefined;
  const { context: _context, message: _message, outputSchema: _schema, ...rest } = input;
  return rest;
}

export function withoutResponses(
  input: StepInput | undefined,
  requestIds: ReadonlySet<string>,
): StepInput | undefined {
  if (input === undefined) return undefined;
  const responses = (input.inputResponses ?? []).filter(
    (response) => !requestIds.has(response.requestId),
  );
  const attributed = (input.attributedInputResponses ?? []).filter(
    ({ response }) => !requestIds.has(response.requestId),
  );
  const { attributedInputResponses: _attributed, inputResponses: _responses, ...rest } = input;
  const result: { -readonly [K in keyof StepInput]: StepInput[K] } = rest;
  if (responses.length > 0) result.inputResponses = responses;
  if (attributed.length > 0) result.attributedInputResponses = attributed;
  return attachClientContext(result, readClientContext(input));
}

/** The last response per request wins. */
export function canonicalizeInputResponses(
  responses: readonly InputResponse[],
): readonly InputResponse[] {
  const byRequestId = new Map<string, InputResponse>();
  for (const response of responses) byRequestId.set(response.requestId, response);
  return [...byRequestId.values()];
}

/**
 * Resolves a free-text reply into responses for `requests`, when it answers
 * them. The consumed message no longer reaches the model.
 */
export function resolveTextResponses(
  requests: readonly InputRequest[],
  input: StepInput | undefined,
): StepInput | undefined {
  if (typeof input?.message !== "string" || requests.length === 0) return input;
  const requestIds = new Set(requests.map((request) => request.requestId));
  if (input.inputResponses?.some((response) => requestIds.has(response.requestId))) {
    return input;
  }
  const responses = resolveTextToResponses(input.message, requests);
  if (responses.length === 0) return input;
  const { message: _message, ...rest } = input;
  return attachClientContext(
    { ...rest, inputResponses: [...(input.inputResponses ?? []), ...responses] },
    readClientContext(input),
  );
}

/** Drops empty fields so held input stays minimal. */
export function compactStepInput(input: StepInput | undefined): StepInput {
  if (input === undefined) return {};
  const result: { -readonly [K in keyof StepInput]: StepInput[K] } = {};
  if ((input.context?.length ?? 0) > 0) result.context = input.context;
  if ((input.inputResponses?.length ?? 0) > 0) result.inputResponses = input.inputResponses;
  if ((input.attributedInputResponses?.length ?? 0) > 0) {
    result.attributedInputResponses = input.attributedInputResponses;
  }
  if (input.message !== undefined) result.message = input.message;
  if (input.messageAuth !== undefined) result.messageAuth = input.messageAuth;
  if (input.outputSchema !== undefined) result.outputSchema = input.outputSchema;
  return attachClientContext(result, readClientContext(input));
}
