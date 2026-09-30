import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { TaskToolCall } from "#execution/tasks/calls.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import { resolveApprovalOutcome } from "#harness/input-request-resolution.js";
import { isObject } from "#shared/guards.js";
import type { InputRequest, InputResponse } from "#shared/input.js";
import type { JsonObject } from "#shared/json.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";

// The turn state is the one durable record of where a session is in its
// lifecycle and what work it still owes. Workflow bodies read it, so this
// module must stay free of runtime dependencies beyond pure helpers.

export const TURN_STATE_KEY = "eve.session";
const TURN_STATE_VERSION = 1;

/** The turn and step every stream event is attributed to. */
export interface EventCoordinates {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}

export interface OpenTurn {
  readonly id: string;
  readonly stepIndex: number;
  /** Assistant output streamed in this turn, so steering can no longer restart it. */
  readonly outputStarted?: boolean;
}

type ToolContentPart = Extract<ModelMessage, { role: "tool" }>["content"][number];
export type ToolResultPart = Extract<ToolContentPart, { type: "tool-result" }>;

/**
 * One tool call a parked step still owes a result for.
 *
 * `awaiting-approval` waits on a person; `approved` waits for eve to run it
 * inline; `ready` waits for the runtime to start its workflow run; `running`
 * waits for that run's (or the session's task tool) result; `settled` holds it.
 */
export interface ParkedCall {
  readonly callId: string;
  readonly toolName: string;
  readonly input: JsonObject;
  readonly status: "awaiting-approval" | "approved" | "ready" | "running" | "settled";
  readonly approval?: {
    readonly request: InputRequest;
    /** A response recorded while sibling approvals in the step are still open. */
    readonly decision?: InputResponse;
    /** Connection identity the tool had when approval was requested. */
    readonly replayIdentity?: string;
    /** The tool authorizes responders, so free text cannot answer it. */
    readonly responsePolicy?: true;
  };
  readonly workflow?: {
    readonly request: RuntimeWorkflowTaskRequest;
    readonly run?: { readonly runId: string; readonly hookToken: string };
  };
  readonly task?: TaskToolCall;
  readonly result?: ToolResultPart;
}

/** One model response whose calls have not all settled. It commits to history once. */
export interface ParkedStep {
  readonly origin: EventCoordinates;
  readonly response: readonly ModelMessage[];
  readonly calls: readonly ParkedCall[];
  /** Auth of the caller whose turn requested approval; `null` when anonymous. */
  readonly requester?: SessionAuthContext | null;
}

/** The harness-authored session-limit continuation prompt. */
export interface LimitPrompt {
  readonly origin: EventCoordinates;
  readonly request: InputRequest;
}

export interface TurnState {
  readonly version: typeof TURN_STATE_VERSION;
  readonly started: boolean;
  /** The open turn's sequence, or the next turn's when none is open. */
  readonly sequence: number;
  readonly turn?: OpenTurn;
  readonly steps: readonly ParkedStep[];
  readonly prompt?: LimitPrompt;
  /** Input held behind the prompt or behind an approval-policy phase. */
  readonly queued?: StepInput;
  /** Approval keys a person approved in this context. */
  readonly grants: readonly string[];
}

const INITIAL: TurnState = {
  grants: [],
  sequence: 0,
  started: false,
  steps: [],
  version: TURN_STATE_VERSION,
};

export function readTurnState(state: SessionStateMap | undefined): TurnState {
  // Only this module writes the key, so a matching version vouches for the shape.
  const raw = state?.[TURN_STATE_KEY] as TurnState | undefined;
  if (raw === undefined) return INITIAL;
  if (!isObject(raw) || raw.version !== TURN_STATE_VERSION || !Array.isArray(raw.steps)) {
    throw new Error("Unsupported session state: start a new session.");
  }
  return raw;
}

export function writeTurnState<T extends { readonly state?: SessionStateMap }>(
  session: T,
  turnState: TurnState,
): T {
  assertUniqueCalls(turnState);
  return { ...session, state: { ...session.state, [TURN_STATE_KEY]: turnState } };
}

export function updateTurnState<T extends { readonly state?: SessionStateMap }>(
  session: T,
  update: (turnState: TurnState) => TurnState,
): T {
  return writeTurnState(session, update(readTurnState(session.state)));
}

function assertUniqueCalls(turnState: TurnState): void {
  const callIds = new Set<string>();
  const requestIds = new Set<string>();
  for (const step of turnState.steps) {
    for (const call of step.calls) {
      if (callIds.has(call.callId)) {
        throw new Error(`Parked steps contain duplicate call id "${call.callId}".`);
      }
      callIds.add(call.callId);
      const requestId = call.approval?.request.requestId;
      if (requestId === undefined) continue;
      if (requestIds.has(requestId)) {
        throw new Error(`Parked steps contain duplicate request id "${requestId}".`);
      }
      requestIds.add(requestId);
    }
  }
}

// ---------------------------------------------------------------------------
// Turn scope
// ---------------------------------------------------------------------------

/** The open turn's id, or the id the next turn will take. */
export function activeTurnId(turnState: TurnState): string {
  return turnState.turn?.id ?? `turn_${turnState.sequence}`;
}

export function isBetweenTurns(turnState: TurnState): boolean {
  return turnState.turn === undefined;
}

/** Coordinates of the open turn's current step, or of the next turn's first step. */
export function eventCoordinates(turnState: TurnState): EventCoordinates {
  return {
    sequence: turnState.sequence,
    stepIndex: turnState.turn?.stepIndex ?? 0,
    turnId: activeTurnId(turnState),
  };
}

export function openTurn(turnState: TurnState): TurnState {
  if (turnState.turn !== undefined) return turnState;
  return { ...turnState, started: true, turn: { id: `turn_${turnState.sequence}`, stepIndex: 0 } };
}

export function advanceStep(turnState: TurnState): TurnState {
  if (turnState.turn === undefined) return turnState;
  const { outputStarted: _outputStarted, ...turn } = turnState.turn;
  return { ...turnState, turn: { ...turn, stepIndex: turn.stepIndex + 1 } };
}

export function markOutputStarted(turnState: TurnState): TurnState {
  if (turnState.turn === undefined || turnState.turn.outputStarted === true) return turnState;
  return { ...turnState, turn: { ...turnState.turn, outputStarted: true } };
}

/** Ends the open turn; the next turn takes the following sequence. */
export function closeTurn(turnState: TurnState): TurnState {
  const { turn: _turn, ...rest } = turnState;
  return { ...rest, started: true, sequence: turnState.sequence + 1 };
}

// ---------------------------------------------------------------------------
// Parked work
// ---------------------------------------------------------------------------

export function allCalls(turnState: TurnState): readonly ParkedCall[] {
  return turnState.steps.flatMap((step) => step.calls);
}

/** Every open approval request, oldest first. */
export function openApprovalRequests(turnState: TurnState): readonly InputRequest[] {
  return allCalls(turnState).flatMap((call) =>
    call.status === "awaiting-approval" && call.approval !== undefined
      ? [call.approval.request]
      : [],
  );
}

/** Every request a response can still answer: open approvals and the prompt. */
export function openRequestIds(turnState: TurnState): ReadonlySet<string> {
  const ids = new Set(openApprovalRequests(turnState).map((request) => request.requestId));
  if (turnState.prompt !== undefined) ids.add(turnState.prompt.request.requestId);
  return ids;
}

export function hasOpenInput(turnState: TurnState): boolean {
  return openRequestIds(turnState).size > 0;
}

export function findStepForRequest(
  turnState: TurnState,
  requestId: string,
): ParkedStep | undefined {
  return turnState.steps.find((step) =>
    step.calls.some((call) => call.approval?.request.requestId === requestId),
  );
}

/** Calls the open turn waits on the runtime for: workflow runs and task tool calls. */
export function runtimeCalls(turnState: TurnState): readonly ParkedCall[] {
  return allCalls(turnState).filter(
    (call) =>
      (call.status === "ready" || call.status === "running") &&
      (call.workflow !== undefined || call.task !== undefined),
  );
}

export function readyWorkflowCalls(turnState: TurnState): readonly ParkedCall[] {
  return allCalls(turnState).filter(
    (call) => call.status === "ready" && call.workflow !== undefined,
  );
}

/** The origin of the step that owns `callId`. */
export function callOrigin(turnState: TurnState, callId: string): EventCoordinates | undefined {
  return turnState.steps.find((step) => step.calls.some((call) => call.callId === callId))?.origin;
}

export function findCall(turnState: TurnState, callId: string): ParkedCall | undefined {
  return allCalls(turnState).find((call) => call.callId === callId);
}

/** A workflow run the session waits on, by the call it answers. */
export function findWorkflowRun(
  turnState: TurnState,
  callId: string,
):
  | {
      readonly callId: string;
      readonly toolName: string;
      readonly origin: EventCoordinates;
      readonly address: { readonly runId: string; readonly hookToken: string };
    }
  | undefined {
  for (const step of turnState.steps) {
    for (const call of step.calls) {
      if (call.callId !== callId || call.status !== "running") continue;
      const run = call.workflow?.run;
      if (run === undefined) continue;
      return { address: run, callId, origin: step.origin, toolName: call.toolName };
    }
  }
  return undefined;
}

/** Every started workflow run the session still waits on. */
export function workflowRuns(turnState: TurnState): readonly {
  readonly callId: string;
  readonly toolName: string;
  readonly address: { readonly runId: string; readonly hookToken: string };
}[] {
  return allCalls(turnState).flatMap((call) =>
    call.status === "running" && call.workflow?.run !== undefined
      ? [{ address: call.workflow.run, callId: call.callId, toolName: call.toolName }]
      : [],
  );
}

export function parkStep(turnState: TurnState, step: ParkedStep): TurnState {
  return { ...turnState, steps: [...turnState.steps, step] };
}

export function updateCall(
  turnState: TurnState,
  callId: string,
  update: (call: ParkedCall) => ParkedCall,
): TurnState {
  return {
    ...turnState,
    steps: turnState.steps.map((step) =>
      step.calls.some((call) => call.callId === callId)
        ? {
            ...step,
            calls: step.calls.map((call) => (call.callId === callId ? update(call) : call)),
          }
        : step,
    ),
  };
}

export function settleCall(
  turnState: TurnState,
  callId: string,
  result: ToolResultPart,
): TurnState {
  return updateCall(turnState, callId, (call) =>
    call.status === "settled" ? call : { ...call, result, status: "settled" },
  );
}

/** Starts a ready workflow call: the session now waits on its run. */
export function startWorkflowCall(
  turnState: TurnState,
  callId: string,
  run: { readonly runId: string; readonly hookToken: string },
): TurnState {
  return updateCall(turnState, callId, (call) =>
    call.workflow === undefined
      ? call
      : { ...call, status: "running", workflow: { ...call.workflow, run } },
  );
}

/**
 * Removes the steps whose calls have all settled and returns the messages
 * each appends to history, in park order. A step's results join its trailing
 * tool message, or form one.
 */
export function takeSettledSteps(turnState: TurnState): {
  readonly turnState: TurnState;
  readonly messages: readonly ModelMessage[];
  readonly steps: readonly ParkedStep[];
} {
  const settled = turnState.steps.filter((step) =>
    step.calls.every((call) => call.status === "settled"),
  );
  if (settled.length === 0) return { turnState, messages: [], steps: [] };
  return {
    turnState: { ...turnState, steps: turnState.steps.filter((step) => !settled.includes(step)) },
    messages: settled.flatMap(stepTranscript),
    steps: settled,
  };
}

function stepTranscript(step: ParkedStep): ModelMessage[] {
  const parts: ToolContentPart[] = [];
  for (const call of step.calls) {
    const decision = call.approval?.decision;
    if (call.approval !== undefined && decision !== undefined) {
      const outcome = resolveApprovalOutcome(decision);
      const response: Extract<ToolContentPart, { type: "tool-approval-response" }> = {
        approvalId: call.approval.request.requestId,
        approved: outcome.approved,
        type: "tool-approval-response",
      };
      if (outcome.reason !== undefined) response.reason = outcome.reason;
      parts.push(response);
    }
    if (call.result !== undefined) parts.push(call.result);
  }
  const messages = [...step.response];
  if (parts.length === 0) return messages;
  const tail = messages.at(-1);
  if (tail?.role === "tool") {
    messages[messages.length - 1] = { content: [...tail.content, ...parts], role: "tool" };
  } else {
    messages.push({ content: parts, role: "tool" });
  }
  return messages;
}

/** What the model reads for a call a scope close stopped before it settled. */
export const CANCELLED_CALL_RESULT = "The turn was cancelled before this call finished.";

function cancelledResult(call: ParkedCall): ToolResultPart {
  return {
    output: { type: "text", value: CANCELLED_CALL_RESULT },
    toolCallId: call.callId,
    toolName: call.toolName,
    type: "tool-result",
  };
}

/**
 * Closes the open turn as cancelled. Every call the turn waits on, and every
 * call parked by the turn itself, settles as cancelled so the model sees that
 * the work started and stopped rather than a request left unanswered.
 */
export function cancelTurnWork(turnState: TurnState): TurnState {
  const turnId = activeTurnId(turnState);
  let next: TurnState = { ...turnState, prompt: undefined };
  for (const step of turnState.steps) {
    const owned = step.origin.turnId === turnId;
    for (const call of step.calls) {
      if (call.status === "settled") continue;
      const waited =
        call.status === "ready" || call.status === "running" || call.status === "approved";
      if (owned || waited) next = settleCall(next, call.callId, cancelledResult(call));
    }
  }
  return next;
}

/** A request asked at `origin` that the session no longer takes an answer for. */
export interface WithdrawnRequest {
  readonly origin: EventCoordinates;
  readonly request: InputRequest;
}

/** The requests `before` takes answers for and `after` does not. */
export function withdrawnRequests(
  before: TurnState,
  after: TurnState,
): readonly WithdrawnRequest[] {
  const kept = new Set(openRequests(after).map(({ request }) => request.requestId));
  return openRequests(before).filter(({ request }) => !kept.has(request.requestId));
}

function openRequests(turnState: TurnState): readonly WithdrawnRequest[] {
  const approvals = turnState.steps.flatMap((step) =>
    step.calls.flatMap((call) =>
      call.status === "awaiting-approval" && call.approval !== undefined
        ? [{ origin: step.origin, request: call.approval.request }]
        : [],
    ),
  );
  return turnState.prompt === undefined ? approvals : [...approvals, turnState.prompt];
}

/** A cleared context owes nothing: parked steps, the prompt, queued input, and grants go. */
export function clearContextWork(turnState: TurnState): TurnState {
  return {
    ...turnState,
    grants: [],
    prompt: undefined,
    queued: undefined,
    steps: [],
  };
}

/** Holds input until the prompt or approval policy phase in front of it resolves. */
export function setQueuedInput(turnState: TurnState, input: StepInput | undefined): TurnState {
  const { queued: _queued, ...rest } = turnState;
  return input === undefined ? rest : { ...rest, queued: input };
}

export function grantApprovals(turnState: TurnState, keys: readonly string[]): TurnState {
  if (keys.length === 0) return turnState;
  return { ...turnState, grants: [...new Set([...turnState.grants, ...keys])] };
}
