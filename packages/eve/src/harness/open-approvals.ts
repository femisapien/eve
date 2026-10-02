import { contextStorage } from "#context/container.js";
import type { SessionAuthContext } from "#channel/types.js";
import { AuthKey, SessionKey } from "#context/keys.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import { coalesceTurnInputs } from "#harness/messages.js";
import {
  readApprovalStep,
  readTurnState,
  writeTurnState,
  type StepCoordinates,
  type SuspendedStep,
} from "#harness/turn-state.js";
import type { HarnessSession, SessionStateMap, StepInput } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

/**
 * Stream-emit coordinates carried so a request's resolution can attribute its
 * events to the turn and step that asked for it.
 */
export type InputRequestEvent = StepCoordinates;

/**
 * The tool approvals the suspended step waits on. A held turn does not call the
 * model while an approval is open, so only one step's approvals can be open.
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
  const step = readApprovalStep(state);
  if (step === undefined) return undefined;
  const open: { -readonly [K in keyof OpenApprovals]: OpenApprovals[K] } = {
    event: step.event,
    requester: step.requester ?? null,
    requests: step.requests,
  };
  if ((step.responseAuthRequiredRequestIds?.length ?? 0) > 0) {
    open.responseAuthRequiredRequestIds = step.responseAuthRequiredRequestIds;
  }
  return open;
}

/** The requester recorded on the step that raised the open approval `requestId`. */
export function openApprovalRequester(
  state: SessionStateMap | undefined,
  requestId: string,
): SessionAuthContext | null {
  const approvals = readOpenApprovals(state);
  if (!approvals?.requests.some((request) => request.requestId === requestId)) return null;
  return approvals.requester;
}

/** The suspended step a model step that raised approvals becomes. */
export function approvalStep(input: {
  readonly event: InputRequestEvent;
  readonly messages: SuspendedStep["messages"];
  readonly requests: readonly InputRequest[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  readonly tasks: SuspendedStep["tasks"];
}): SuspendedStep {
  const step: { -readonly [K in keyof SuspendedStep]: SuspendedStep[K] } = {
    event: input.event,
    messages: input.messages,
    requester: currentRequester(),
    requests: input.requests,
    tasks: input.tasks,
  };
  if ((input.responseAuthRequiredRequestIds?.length ?? 0) > 0) {
    step.responseAuthRequiredRequestIds = input.responseAuthRequiredRequestIds;
  }
  return step;
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

/** Keys `once()` approvals granted, except those an open approval still asks about. */
export function grantedApprovalKeys(
  state: SessionStateMap | undefined,
  approvalKey: (request: InputRequest) => string | undefined,
): ReadonlySet<string> {
  const granted = new Set(readTurnState(state).grants);
  for (const request of readOpenApprovals(state)?.requests ?? []) {
    if (isApprovalRequest(request)) granted.delete(approvalKey(request) ?? request.action.toolName);
  }
  return granted;
}

// ---------------------------------------------------------------------------
// Queued input
// ---------------------------------------------------------------------------

/**
 * Merges queued input into the current step input and clears it from the turn
 * state. Input queues when it can't run yet: a partial answer, input behind a
 * response-policy pass, or input behind approved workflow calls.
 */
export function consumeQueuedInput(input: {
  readonly input?: StepInput;
  readonly session: HarnessSession;
}): {
  readonly input?: StepInput;
  readonly session: HarnessSession;
} {
  const queued = getQueuedInput(input.session);
  if (queued === undefined) return input;
  const turn = readTurnState(input.session.state);
  const session = writeTurnState(input.session, { ...turn, queued: undefined });
  return {
    input: input.input === undefined ? queued : coalesceTurnInputs(queued, input.input),
    session,
  };
}

export function getQueuedInput(session: {
  readonly state?: SessionStateMap;
}): StepInput | undefined {
  return readTurnState(session.state).queued;
}

export function queueInput(session: HarnessSession, input: StepInput): HarnessSession {
  const turn = readTurnState(session.state);
  const queued = turn.queued === undefined ? input : coalesceTurnInputs(turn.queued, input);
  return writeTurnState(session, { ...turn, queued });
}
