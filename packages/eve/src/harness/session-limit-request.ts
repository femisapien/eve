/**
 * The turn's budget question. Over budget, a turn that can reach a person
 * asks whether to continue and stays open until they answer: Continue grants
 * a fresh budget window and the same model call runs, Stop cancels the turn.
 * The question belongs to the turn, so it is one of the open input requests,
 * owned by the turn.
 */
import { resolveTextToResponse } from "#channel/resolve-text.js";
import type { HarnessEmissionState } from "#harness/emission-state.js";
import { textAnswerable } from "#harness/hitl/machine.js";
import {
  openTurnInputRequest,
  readTurnInputRequests,
  retireOpenInputRequests,
} from "#harness/open-input-requests.js";
import { resolveSessionLimitContinuation } from "#harness/session-limit-continuation.js";
import { SessionLimitDeclinedError } from "#harness/turn-cancellation.js";
import { bumpSessionRuntimeUsageLimits } from "#harness/turn-tag-state.js";
import type { HarnessSession, StepInput, ToolLoopHarnessConfig } from "#harness/types.js";
import { createInputResolvedEvent } from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

/** The open budget question and where it was asked. */
export interface OpenSessionLimitRequest {
  readonly request: InputRequest;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** The turn's open budget question, one of the open input requests, owned by the turn. */
export function readSessionLimitRequest(
  session: HarnessSession,
): OpenSessionLimitRequest | undefined {
  for (const entry of readTurnInputRequests(session.state).values()) {
    if (entry.request.kind === "session-limit") return { ...entry.event, request: entry.request };
  }
  return undefined;
}

export function openSessionLimitRequest(
  session: HarnessSession,
  open: OpenSessionLimitRequest,
): HarnessSession {
  const { request, ...event } = open;
  return openTurnInputRequest(session, { event, request });
}

function closeSessionLimitRequest(
  session: HarnessSession,
  open: OpenSessionLimitRequest,
): HarnessSession {
  return retireOpenInputRequests(session, [open.request.requestId]);
}

/**
 * Applies the step input's answer to the open budget question, if it has one.
 * Continue grants a fresh budget window and drops the answer from the input;
 * Stop throws {@link SessionLimitDeclinedError}, which cancels the turn. A
 * plain-text message answers only when it matches an option. Without an
 * answer the question stays open and the input passes through.
 */
export async function answerSessionLimitRequest(input: {
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly session: HarnessSession;
  readonly stepInput: StepInput | undefined;
}): Promise<{ readonly session: HarnessSession; readonly stepInput: StepInput | undefined }> {
  const open = readSessionLimitRequest(input.session);
  if (open === undefined || input.stepInput === undefined) {
    return { session: input.session, stepInput: input.stepInput };
  }
  const { requestId } = open.request;
  const structured = input.stepInput.inputResponses?.find(
    (response) => response.requestId === requestId,
  );
  const typed =
    structured === undefined &&
    typeof input.stepInput.message === "string" &&
    textAnswerable(input.session.state)?.kind === "session-limit"
      ? resolveTextToResponse(input.stepInput.message, open.request)
      : undefined;
  const response: InputResponse | undefined = structured ?? typed;
  const decision =
    response === undefined
      ? undefined
      : resolveSessionLimitContinuation({ requests: [open.request], responses: [response] });
  if (response === undefined || decision === undefined) {
    return { session: input.session, stepInput: input.stepInput };
  }

  await input.emit?.(
    createInputResolvedEvent({
      resolutions: [{ kind: "session-limit", outcome: "answered", requestId, response }],
      sequence: open.sequence,
      stepIndex: open.stepIndex,
      turnId: open.turnId,
    }),
  );
  const session = closeSessionLimitRequest(input.session, open);
  if (!decision.granted) throw new SessionLimitDeclinedError(requestId);

  const remaining = input.stepInput.inputResponses?.filter(
    (entry) => entry.requestId !== requestId,
  );
  const stepInput: StepInput = {
    ...input.stepInput,
    inputResponses: remaining !== undefined && remaining.length > 0 ? remaining : undefined,
    message: typed !== undefined ? undefined : input.stepInput.message,
  };
  return { session: bumpSessionRuntimeUsageLimits(session), stepInput };
}

/** Where the question is asked: the turn's current coordinates. */
export function sessionLimitRequestAt(
  request: InputRequest,
  emissionState: HarnessEmissionState,
): OpenSessionLimitRequest {
  return {
    request,
    sequence: emissionState.sequence,
    stepIndex: emissionState.stepIndex,
    turnId: emissionState.turnId,
  };
}
