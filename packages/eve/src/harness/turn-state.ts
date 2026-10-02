import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";

/**
 * What execution keeps between steps to resume a turn: input that arrived
 * before it could run, the model step whose calls wait on a person or the
 * runtime, and the approval keys `once()` approvals granted.
 */
export const TURN_STATE_KEY = "eve.harness.turnState";

type ToolResponsePart = Extract<ModelMessage, { role: "tool" }>["content"][number];
export type ToolResultPart = Extract<ToolResponsePart, { type: "tool-result" }>;

/** The coordinates of the model step a suspended step parked from. */
export interface StepCoordinates {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

/**
 * A model step whose calls can't all settle yet: some await an approval, others the runtime.
 * Its response stays out of history until every call it made has a result there, so a call
 * never reaches the model without its result.
 */
export interface SuspendedStep {
  readonly event: StepCoordinates;
  /** The withheld response. Results join it as they arrive. */
  readonly messages: readonly ModelMessage[];
  /** Approvals the step still waits on. */
  readonly requests: readonly InputRequest[];
  /** Workflow and agent calls the runtime runs for the step. */
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  /** The caller whose turn parked the step; `null` when unauthenticated. */
  readonly requester?: SessionAuthContext | null;
}

export interface TurnState {
  /** Input that arrived before it could run: a partial answer, or input behind a policy pass. */
  readonly queued?: StepInput;
  /**
   * The model isn't called while a step waits on approvals or the runtime, so at most one
   * step holds open approvals.
   */
  readonly suspended: readonly SuspendedStep[];
  /** Approval keys a `once()` approval granted for the rest of the session. */
  readonly grants: readonly string[];
}

const EMPTY_TURN_STATE: TurnState = { grants: [], suspended: [] };

export function readTurnState(state: SessionStateMap | undefined): TurnState {
  const value = state?.[TURN_STATE_KEY];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return EMPTY_TURN_STATE;
  const turn = value as Partial<TurnState>;
  return {
    ...turn,
    grants: Array.isArray(turn.grants) ? turn.grants : [],
    suspended: Array.isArray(turn.suspended) ? turn.suspended : [],
  };
}

export function writeTurnState<T extends { readonly state?: SessionStateMap }>(
  session: T,
  turn: TurnState,
): T {
  return { ...session, state: writeTurnStateMap(session.state, turn) };
}

export function writeTurnStateMap(
  state: SessionStateMap | undefined,
  turn: TurnState,
): SessionStateMap | undefined {
  const next: Record<string, unknown> = { ...state };
  if (turn.suspended.length === 0 && turn.queued === undefined && turn.grants.length === 0) {
    delete next[TURN_STATE_KEY];
  } else {
    const { queued, ...rest } = turn;
    next[TURN_STATE_KEY] = queued === undefined ? rest : turn;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** The step that waits on approvals, if one does. */
export function readApprovalStep(state: SessionStateMap | undefined): SuspendedStep | undefined {
  return readTurnState(state).suspended.find((step) => step.requests.length > 0);
}

/** Replaces `previous`, matched by its coordinates; `undefined` removes it. */
export function replaceSuspendedStep<T extends { readonly state?: SessionStateMap }>(
  session: T,
  previous: SuspendedStep,
  next: SuspendedStep | undefined,
): T {
  const turn = readTurnState(session.state);
  const suspended = turn.suspended.flatMap((step) =>
    isSameStep(step, previous) ? (next === undefined ? [] : [next]) : [step],
  );
  return writeTurnState(session, { ...turn, suspended });
}

/** Whether two records are the same model step, by the coordinates it parked from. */
export function isSameStep(a: SuspendedStep, b: SuspendedStep): boolean {
  return (
    a.event.turnId === b.event.turnId &&
    a.event.sequence === b.event.sequence &&
    a.event.stepIndex === b.event.stepIndex
  );
}

/** Parks a model step whose calls can't all settle yet. */
export function suspendStep<T extends { readonly state?: SessionStateMap }>(
  session: T,
  step: SuspendedStep,
): T {
  assertUniqueCoordinationCallIds(step.tasks);
  const turn = readTurnState(session.state);
  return writeTurnState(session, { ...turn, suspended: [...turn.suspended, step] });
}

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

/** The ids of the calls a step's response made, except provider-executed ones. */
export function stepCallIds(step: Pick<SuspendedStep, "messages">): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of step.messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-call" && part.providerExecuted !== true) ids.add(part.toolCallId);
    }
  }
  return ids;
}

/** The ids of the calls `messages` already hold a result for. */
export function answeredCallIds(messages: readonly ModelMessage[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result") ids.add(part.toolCallId);
    }
  }
  return ids;
}

/** Whether every call the step made has a result and no approval is still open. */
export function isStepComplete(step: SuspendedStep): boolean {
  if (step.requests.length > 0) return false;
  const answered = answeredCallIds(step.messages);
  return [...stepCallIds(step)].every((callId) => answered.has(callId));
}

/** Places a result right after the message that made its call. */
export function withResult(
  messages: readonly ModelMessage[],
  part: ToolResultPart,
): ModelMessage[] {
  const next = [...messages];
  const asking = next.findIndex(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (content) => content.type === "tool-call" && content.toolCallId === part.toolCallId,
      ),
  );
  const following = next[asking + 1];
  if (asking >= 0 && following?.role === "tool") {
    next[asking + 1] = { ...following, content: [...following.content, part] };
  } else {
    next.splice(asking >= 0 ? asking + 1 : next.length, 0, { content: [part], role: "tool" });
  }
  return next;
}

/**
 * Results reach the steps that made their calls. A step whose every call now has a result
 * leaves the turn state and returns in `commit`, for history, where the model reads it.
 */
export function settleSuspendedStep<T extends { readonly state?: SessionStateMap }>(
  session: T,
  results: readonly ToolResultPart[],
): { readonly commit: readonly ModelMessage[]; readonly session: T } {
  const turn = readTurnState(session.state);
  const steps = [...turn.suspended];
  for (const part of results) {
    const index = steps.findIndex((step) => stepCallIds(step).has(part.toolCallId));
    const step = steps[index];
    if (step === undefined) continue;
    steps[index] = { ...step, messages: withResult(step.messages, part) };
  }
  const complete = steps.filter(isStepComplete);
  return {
    commit: complete.flatMap((step) => step.messages),
    session: writeTurnState(session, {
      ...turn,
      suspended: steps.filter((step) => !complete.includes(step)),
    }),
  };
}
