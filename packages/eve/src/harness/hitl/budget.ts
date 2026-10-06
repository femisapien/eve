/**
 * The budget question. Over budget before a model call, a turn a person can
 * reach asks whether to continue and waits until they answer: Continue grants
 * a fresh budget window and the same model call runs, Stop cancels the turn.
 * A message that does not answer it stays in the turn's history, read once the
 * turn runs again.
 */
import type { Command } from "#harness/hitl/command.js";
import type { Input } from "#harness/hitl/input.js";
import type { HumanInputState, Reduced } from "#harness/hitl/state.js";
import {
  SESSION_LIMIT_CONTINUE_OPTION_ID,
  SESSION_LIMIT_STOP_OPTION_ID,
} from "#harness/hitl/budget-question.js";
import {
  createInputRequestedEvent,
  createInputResolvedEvent,
  type InputResolutionOutcome,
} from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";

type BudgetRequest = Extract<
  HumanInputState["requests"][string],
  { readonly kind: "session-limit" }
>;

/** Opens the budget question, or waits on it again: each violation is asked once. */
export function askBudget(
  state: HumanInputState,
  input: Extract<Input, { readonly type: "budget.exceeded" }>,
): Reduced {
  const { at, request } = input;
  if (state.requests[request.requestId] !== undefined) return { events: [], state };
  return {
    events: [{ event: createInputRequestedEvent({ ...at, requests: [request] }), type: "publish" }],
    state: {
      ...state,
      requests: { ...state.requests, [request.requestId]: { at, kind: "session-limit", request } },
    },
  };
}

/**
 * Applies the answers to the budget question, the last one winning. An
 * answer with neither option is dropped, like a late one. Returns the answers
 * to other requests as `unclaimed`.
 */
export function answerBudget(
  state: HumanInputState,
  responses: readonly InputResponse[],
): Reduced & { readonly unclaimed: readonly InputResponse[] } {
  let next = state;
  const events: Command[] = [];
  const unclaimed: InputResponse[] = [];
  const answers = new Map<string, InputResponse>();
  for (const response of responses) {
    if (next.requests[response.requestId]?.kind === "session-limit") {
      answers.set(response.requestId, response);
    } else {
      unclaimed.push(response);
    }
  }
  for (const response of answers.values()) {
    const open = next.requests[response.requestId];
    if (open?.kind !== "session-limit") continue;
    const decided = decide(open, response);
    if (decided === undefined) continue;
    next = close(next, open);
    events.push(...decided);
  }
  return { events, state: next, unclaimed };
}

/**
 * A Stop ended the turn: the cancelled turn settles from before the step that
 * read it, so the question it answered closes again, with nothing published.
 */
export function stopBudget(state: HumanInputState, requestId: string): Reduced {
  const open = openBudget(state);
  if (open?.request.requestId !== requestId) return { events: [], state };
  return { events: [], state: close(state, open) };
}

/** The turn was cancelled: its budget question closes unanswered. */
export function withdrawBudget(state: HumanInputState): Reduced {
  const open = openBudget(state);
  if (open === undefined) return { events: [], state };
  return { events: [resolved(open, "cancelled")], state: close(state, open) };
}

function decide(open: BudgetRequest, response: InputResponse): Command[] | undefined {
  switch (response.optionId) {
    case SESSION_LIMIT_CONTINUE_OPTION_ID:
      return [resolved(open, "answered", response), { type: "grantBudget" }];
    case SESSION_LIMIT_STOP_OPTION_ID:
      return [
        resolved(open, "answered", response),
        { requestId: open.request.requestId, type: "declineBudget" },
      ];
    default:
      return undefined;
  }
}

function openBudget(state: HumanInputState): BudgetRequest | undefined {
  for (const open of Object.values(state.requests)) {
    if (open.kind === "session-limit") return open;
  }
  return undefined;
}

function close(state: HumanInputState, open: BudgetRequest): HumanInputState {
  const { [open.request.requestId]: _closed, ...requests } = state.requests;
  return { ...state, requests };
}

function resolved(
  open: BudgetRequest,
  outcome: InputResolutionOutcome,
  response?: InputResponse,
): Command {
  const { requestId } = open.request;
  return {
    event: createInputResolvedEvent({
      ...open.at,
      resolutions: [{ kind: "session-limit", outcome, requestId, ...(response && { response }) }],
    }),
    type: "publish",
  };
}
