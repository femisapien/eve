import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import {
  advanceStep,
  closeTurn,
  eventCoordinates,
  openTurn,
  parkStep,
  readTurnState,
  writeTurnState,
  type OpenTurn,
} from "#harness/turn-state.js";
import type { SessionStateMap } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

type WithState = { readonly state?: SessionStateMap };

/**
 * Parks one model response whose calls wait on approval, the way a model
 * step does: in the open turn (or a new one), which then closes.
 */
export function parkApprovalStep<T extends WithState>(
  session: T,
  input: {
    readonly requests: readonly InputRequest[];
    readonly requester?: SessionAuthContext | null;
    readonly response: readonly ModelMessage[];
    /** The tools authorize responders, so free text cannot answer them. */
    readonly responsePolicy?: true;
  },
): T {
  const opened = openTurn(readTurnState(session.state));
  const parked = parkStep(opened, {
    calls: input.requests.map((request) => ({
      approval: input.responsePolicy === true ? { request, responsePolicy: true } : { request },
      callId: request.action.callId,
      input: request.action.input,
      status: "awaiting-approval",
      toolName: request.action.toolName,
    })),
    origin: eventCoordinates(opened),
    requester: input.requester,
    response: input.response,
  });
  return writeTurnState(session, closeTurn(parked));
}

/** Places the session inside `turn`, or between turns when it is omitted. */
export function atSessionTurn<T extends WithState>(
  session: T,
  input: { readonly sequence: number; readonly started?: boolean; readonly turn?: OpenTurn },
): T {
  const { turn: _turn, ...turnState } = readTurnState(session.state);
  const placed = { ...turnState, sequence: input.sequence, started: input.started ?? true };
  return writeTurnState(
    session,
    input.turn === undefined ? placed : { ...placed, turn: input.turn },
  );
}

/**
 * Parks one model response whose workflow calls are running, the way a model
 * step does after execution starts their runs: the turn stays open, waiting.
 */
export function parkWorkflowRuns<T extends WithState>(
  session: T,
  calls: readonly {
    readonly callId: string;
    readonly toolName: string;
    readonly run: { readonly runId: string; readonly hookToken: string };
  }[],
): T {
  const opened = openTurn(readTurnState(session.state));
  const parked = parkStep(opened, {
    calls: calls.map((call) => ({
      callId: call.callId,
      input: {},
      status: "running",
      toolName: call.toolName,
      workflow: {
        request: {
          callId: call.callId,
          entry: { entryPoint: "execute" },
          input: {},
          kind: "workflow-task",
          toolName: call.toolName,
          workflowId: `${call.toolName}-workflow`,
        },
        run: call.run,
      },
    })),
    origin: eventCoordinates(opened),
    response: [],
  });
  return writeTurnState(session, advanceStep(parked));
}
