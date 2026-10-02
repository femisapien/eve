import { contextStorage } from "#context/container.js";
import type { SessionAuthContext } from "#channel/types.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import type { InputRequest } from "#shared/input.js";
import type { HarnessSession, SessionStateMap, StepInput } from "#harness/types.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import {
  openTurnInputRequest,
  readTurnInputRequests,
  retireOpenInputRequests,
} from "#harness/open-input-requests.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const DEFERRED_STEP_INPUT_KEY = "eve.runtime.deferredStepInput";

/**
 * Stream-emit coordinates carried so a request's resolution can attribute its
 * events to the turn and step that asked for it.
 */
export interface PendingInputBatchEvent {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/**
 * The tool approvals one model step raised, read from the turn's entries in
 * the open input requests. A held turn does not call the model while an
 * approval is open, so at most one step's approvals are open at once.
 */
export interface PendingInputBatch {
  readonly event: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  /**
   * Auth of the caller whose turn raised the approvals; `null` when that caller
   * was unauthenticated.
   */
  readonly requester: SessionAuthContext | null;
  readonly responseAuthRequiredRequestIds?: readonly string[];
}

/** Returns true when the turn waits on tool approvals. */
export function hasPendingInputBatch(state: SessionStateMap | undefined): boolean {
  return getPendingInputBatches(state).length > 0;
}

/** Returns the request IDs of the open tool approvals. */
export function getPendingInputRequestIds(state: SessionStateMap | undefined): ReadonlySet<string> {
  return new Set(
    getPendingInputBatches(state).flatMap((batch) =>
      batch.requests.map((request) => request.requestId),
    ),
  );
}

/** The open tool approvals, as the one batch their model step raised. */
export function getPendingInputBatches(
  state: SessionStateMap | undefined,
): readonly PendingInputBatch[] {
  const approvals = [...readTurnInputRequests(state).values()].filter(
    (entry) => entry.request.kind === "tool-approval",
  );
  const first = approvals[0];
  if (first === undefined) return [];
  const responseAuthRequiredRequestIds = approvals
    .filter((entry) => entry.responseAuthRequired === true)
    .map((entry) => entry.request.requestId);
  const batch: Mutable<PendingInputBatch> = {
    event: first.event,
    requester: first.requester ?? null,
    requests: approvals.map((entry) => entry.request),
  };
  if (responseAuthRequiredRequestIds.length > 0) {
    batch.responseAuthRequiredRequestIds = responseAuthRequiredRequestIds;
  }
  return [batch];
}

/** Closes the given approval batches from a prior {@link getPendingInputBatches} read. */
export function removePendingInputBatches(
  session: HarnessSession,
  batches: readonly PendingInputBatch[],
): HarnessSession {
  return retireOpenInputRequests(
    session,
    batches.flatMap((batch) => batch.requests.map((request) => request.requestId)),
  );
}

/** Opens the tool approvals one model step raised, as turn entries. */
export function appendPendingInputBatch(input: {
  readonly event: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  readonly session: HarnessSession;
}): HarnessSession {
  if (hasPendingInputBatch(input.session.state)) {
    throw new Error(
      "eve internal error: a model step raised tool approvals while earlier approvals are open. A held turn must not call the model until every approval is answered or withdrawn.",
    );
  }
  const requester = currentRequester();
  const responseAuthRequired = new Set(input.responseAuthRequiredRequestIds ?? []);
  let session = input.session;
  for (const request of input.requests) {
    const entry: Mutable<Parameters<typeof openTurnInputRequest>[1]> = {
      event: input.event,
      request,
      requester,
    };
    if (responseAuthRequired.has(request.requestId)) entry.responseAuthRequired = true;
    session = openTurnInputRequest(session, entry);
  }
  return session;
}

/**
 * Every anonymous caller shares one synthetic identity, so an anonymous
 * requester can't be told apart from another anonymous responder: record none.
 */
function currentRequester(): SessionAuthContext | null {
  const context = contextStorage.getStore();
  const auth = context?.get(AuthKey) ?? context?.get(SessionKey)?.auth.current ?? null;
  return auth?.principalType === "anonymous" ? null : auth;
}

/** The requester recorded on the open approval `requestId`. */
export function pendingInputRequester(
  state: SessionStateMap | undefined,
  requestId: string,
): SessionAuthContext | null {
  return readTurnInputRequests(state).get(requestId)?.requester ?? null;
}

// ---------------------------------------------------------------------------
// Deferred step input
// ---------------------------------------------------------------------------

/**
 * Merges any queued follow-up input into the current step input and clears it
 * from session state.
 *
 * Used when the harness has to process a pending tool-approval response first
 * and defer the user's new message to the next internal model step.
 */
export function consumeDeferredStepInput(input: {
  readonly input?: StepInput;
  readonly session: HarnessSession;
}): {
  readonly input?: StepInput;
  readonly session: HarnessSession;
} {
  const deferredInput = getDeferredStepInput(input.session);

  if (deferredInput === undefined) {
    return input;
  }

  const session = clearDeferredStepInput(input.session);

  if (input.input === undefined) {
    return {
      input: deferredInput,
      session,
    };
  }

  return {
    input: coalesceTurnInputs(deferredInput, input.input),
    session,
  };
}

export function getDeferredStepInput(session: HarnessSession): StepInput | undefined {
  return session.state?.[DEFERRED_STEP_INPUT_KEY] as StepInput | undefined;
}

export function queueDeferredStepInput(session: HarnessSession, input: StepInput): HarnessSession {
  const existing = getDeferredStepInput(session);
  const deferredInput = existing === undefined ? input : coalesceTurnInputs(existing, input);
  const state = { ...session.state };
  state[DEFERRED_STEP_INPUT_KEY] = deferredInput;

  return {
    ...session,
    state,
  };
}

function clearDeferredStepInput(session: HarnessSession): HarnessSession {
  if (session.state?.[DEFERRED_STEP_INPUT_KEY] === undefined) {
    return session;
  }

  const state = { ...session.state };
  delete state[DEFERRED_STEP_INPUT_KEY];

  return {
    ...session,
    state: Object.keys(state).length > 0 ? state : undefined,
  };
}
