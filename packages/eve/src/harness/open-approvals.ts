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
export interface InputRequestEvent {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/**
 * The tool approvals one model step raised, read from the turn's entries in
 * the open input requests. A held turn does not call the model while an
 * approval is open, so only one step's approvals can be open at once.
 */
export interface OpenApprovals {
  readonly event: InputRequestEvent;
  readonly requests: readonly InputRequest[];
  /**
   * Auth of the caller whose turn raised the approvals; `null` when that caller
   * was unauthenticated.
   */
  readonly requester: SessionAuthContext | null;
  readonly responseAuthRequiredRequestIds?: readonly string[];
}

/** Returns true when the turn waits on tool approvals. */
export function hasOpenApprovals(state: SessionStateMap | undefined): boolean {
  return readOpenApprovals(state) !== undefined;
}

/** Returns the request IDs of the open tool approvals. */
export function openApprovalRequestIds(state: SessionStateMap | undefined): ReadonlySet<string> {
  return new Set(readOpenApprovals(state)?.requests.map((request) => request.requestId));
}

/** The open tool approvals, or `undefined` when none are open. */
export function readOpenApprovals(state: SessionStateMap | undefined): OpenApprovals | undefined {
  const approvals = [...readTurnInputRequests(state).values()].filter(
    (entry) => entry.request.kind === "tool-approval",
  );
  const first = approvals[0];
  if (first === undefined) return undefined;
  const responseAuthRequiredRequestIds = approvals
    .filter((entry) => entry.responseAuthRequired === true)
    .map((entry) => entry.request.requestId);
  const open: Mutable<OpenApprovals> = {
    event: first.event,
    requester: first.requester ?? null,
    requests: approvals.map((entry) => entry.request),
  };
  if (responseAuthRequiredRequestIds.length > 0) {
    open.responseAuthRequiredRequestIds = responseAuthRequiredRequestIds;
  }
  return open;
}

/** Closes every open tool approval; other open input requests stay open. */
export function closeApprovals(session: HarnessSession): HarnessSession {
  return retireOpenInputRequests(session, [...openApprovalRequestIds(session.state)]);
}

/** Opens the tool approvals one model step raised, as turn entries. */
export function openApprovals(input: {
  readonly event: InputRequestEvent;
  readonly requests: readonly InputRequest[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  readonly session: HarnessSession;
}): HarnessSession {
  if (hasOpenApprovals(input.session.state)) {
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
export function openApprovalRequester(
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
