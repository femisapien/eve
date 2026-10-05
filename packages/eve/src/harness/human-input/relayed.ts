/**
 * Relayed requests: questions and approvals a child session, a remote agent,
 * or a workflow run's `ctx.ask()` asks a person through this session. The call
 * that asked keeps running, so the turn waits on it rather than holding for
 * the model; the session only carries the exchange. It announces each child
 * batch at the child's coordinates, forwards the answers to whoever asked, and
 * withdraws what nobody can answer anymore.
 */
import { SESSION_LIMIT_STOP_OPTION_ID } from "#harness/human-input/budget-question.js";
import {
  createInputRequestedEvent,
  createInputResolvedEvent,
  type InputResolution,
} from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

import { outcomeOf } from "./approvals.js";
import type {
  HumanInputEvent,
  HumanInputState,
  Intake,
  Interrupt,
  RelayRoute,
  RequestAt,
  Reduced,
} from "./index.js";
import { typedAnswers } from "./typed-replies.js";

/** A relayed request, as the session stores it until it is answered or withdrawn. */
export interface OpenRelayed {
  readonly kind: "relayed";
  /** The coordinates of the child batch's `input.requested`, which its `input.resolved` repeats. */
  readonly at: RequestAt;
  readonly request: InputRequest;
  readonly route: RelayRoute;
}

/**
 * A child or run asks. Its fresh batch replaces the one it asked before from
 * the same source, whose requests still open are withdrawn, and the turn
 * waits on the call that asked.
 */
export function relay(
  state: HumanInputState,
  interrupt: Extract<Interrupt, { readonly type: "relayed.requested" }>,
): Reduced {
  const { at, requests, route } = interrupt;
  const fresh = new Set(requests.map((request) => request.requestId));
  const replaced = openRelayed(state).filter(
    (open) => sameSource(open.route, route) && !fresh.has(open.request.requestId),
  );
  const next: Record<string, HumanInputState["requests"][string]> = {
    ...without(state, replaced).requests,
  };
  for (const request of requests) {
    const open: OpenRelayed = { at, kind: "relayed", request, route };
    next[request.requestId] = open;
  }
  return {
    events: [
      ...withdrawn(replaced),
      relayed(
        createInputRequestedEvent({
          ...at,
          requests,
          ...(interrupt.taskId !== undefined && { taskId: interrupt.taskId }),
        }),
      ),
      { relayed: true, type: "turn.held" },
    ],
    state: { ...state, requests: next },
  };
}

/**
 * A delivery reached the session while relayed requests wait. Each answer to
 * one goes to whoever asked; the first answer to a request wins, and a request
 * closes once answered, so a later answer is the turn's again. A batch
 * resolves as its child does: without approvals, any answer closes the rest
 * as ignored; with approvals, once every approval is answered.
 *
 * A plain-text message answers a relayed question when it is the only one
 * waiting, whatever else is open, but only a person's own message with no
 * explicit answers: a delegating caller or a client that chose what to answer
 * meant something else. A relayed budget Stop also cancels this turn.
 */
export function deliverToRelayed(
  state: HumanInputState,
  input: Extract<Intake, { readonly type: "delivered" }>,
): Reduced {
  const { message } = input;
  const typed =
    input.responses.length > 0 || message === undefined || message.delegated
      ? undefined
      : typedAnswers(state, message.text, "relayed")[0];
  const responses = typed === undefined ? input.responses : [typed];

  const answers = new Map<string, InputResponse>();
  for (const response of responses) {
    if (isOpenRelayed(state.requests[response.requestId]) && !answers.has(response.requestId)) {
      answers.set(response.requestId, response);
    }
  }
  if (answers.size === 0) return { events: [], state };

  const batches = new Map<string, OpenRelayed[]>();
  for (const requestId of answers.keys()) {
    const open = state.requests[requestId] as OpenRelayed;
    const key = batchKey(open);
    if (!batches.has(key))
      batches.set(
        key,
        openRelayed(state).filter((o) => batchKey(o) === key),
      );
  }

  const events: HumanInputEvent[] = typed === undefined ? [] : [{ type: "message.answered" }];
  let next = state;
  let stopped = false;
  for (const members of batches.values()) {
    const answered = members.filter((open) => answers.has(open.request.requestId));
    const completes = members
      .filter((open) => open.request.kind === "tool-approval")
      .every((open) => answers.has(open.request.requestId));
    const retired = completes ? members : answered;
    events.push({
      responses: answered.map((open) => answers.get(open.request.requestId)!),
      route: members[0]!.route,
      type: "answer.forwarded",
    });
    events.push(
      relayed(
        createInputResolvedEvent({
          ...members[0]!.at,
          resolutions: retired.map((open) => resolution(open, answers.get(open.request.requestId))),
        }),
      ),
    );
    next = without(next, retired);
    stopped ||= answered.some(
      (open) =>
        open.request.kind === "session-limit" &&
        answers.get(open.request.requestId)?.optionId === SESSION_LIMIT_STOP_OPTION_ID,
    );
  }
  if (stopped) events.push({ type: "turn.cancelled" });
  return { events, state: next };
}

/** A sign-in a child or run started through this session, recorded until it completes. */
export interface RelayedSignIn {
  readonly at: RequestAt;
  readonly name: string;
  readonly runId: string;
}

/**
 * A child or run signs in, or reports its responders' approval candidates.
 * The session publishes the event as relayed and records the sign-in until
 * its completion arrives the same way; the turn waits on the call that asked.
 */
export function relayAuthorization(
  state: HumanInputState,
  interrupt: Extract<Interrupt, { readonly type: "relayed.authorization" }>,
): Reduced {
  const { event, runId } = interrupt;
  const published = relayed(event);
  if (event.type === "authorization.required") {
    const { attemptId, name, sequence, stepIndex, turnId } = event.data;
    const next =
      attemptId === undefined
        ? state
        : {
            ...state,
            relayedSignIns: {
              ...state.relayedSignIns,
              [attemptId]: { at: { sequence, stepIndex, turnId }, name, runId },
            },
          };
    return { events: [published, { relayed: true, type: "turn.held" }], state: next };
  }
  if (event.type === "authorization.completed" && event.data.attemptId !== undefined) {
    return { events: [published], state: withoutSignIns(state, [event.data.attemptId]) };
  }
  return { events: [published], state };
}

/** A run ended, or the turn was cancelled: nobody can answer what it relayed. */
export function withdrawRelayed(
  state: HumanInputState,
  select: (open: OpenRelayed) => boolean = () => true,
): Reduced {
  const selected = openRelayed(state).filter(select);
  return { events: withdrawn(selected), state: without(state, selected) };
}

/**
 * The sign-ins a run started end with it, or all of them with the turn. Its
 * child reports its own completion, so ending them reports nothing.
 */
export function endRelayedSignIns(state: HumanInputState, runId?: string): Reduced {
  const ended = Object.entries(state.relayedSignIns ?? {})
    .filter(([, signIn]) => runId === undefined || signIn.runId === runId)
    .map(([attemptId]) => attemptId);
  return { events: [], state: withoutSignIns(state, ended) };
}

function withoutSignIns(state: HumanInputState, attemptIds: readonly string[]): HumanInputState {
  if (attemptIds.length === 0 || state.relayedSignIns === undefined) return state;
  const ids = new Set(attemptIds);
  const remaining = Object.fromEntries(
    Object.entries(state.relayedSignIns).filter(([attemptId]) => !ids.has(attemptId)),
  );
  const { relayedSignIns: _dropped, ...rest } = state;
  return Object.keys(remaining).length === 0 ? rest : { ...rest, relayedSignIns: remaining };
}

/**
 * A run asks to withdraw its `ctx.ask()` question. The run hears `withdrawn`
 * either way, after any answer the session already sent it, so the question
 * resolves from the session's first decision; a question still open closes.
 */
export function withdrawAsk(
  state: HumanInputState,
  input: Extract<Intake, { readonly type: "withdraw.requested" }>,
): Reduced {
  const withdrawal = withdrawRelayed(
    state,
    (open) =>
      open.request.requestId === input.requestId &&
      open.route.runId === input.runId &&
      open.route.control !== undefined,
  );
  return {
    events: [
      { control: input.control, requestId: input.requestId, type: "question.withdrawn" },
      ...withdrawal.events,
    ],
    state: withdrawal.state,
  };
}

export function relayedRequestIds(state: HumanInputState): ReadonlySet<string> {
  return new Set(openRelayed(state).map((open) => open.request.requestId));
}

export function isOpenRelayed(value: { readonly kind: string } | undefined): value is OpenRelayed {
  return value?.kind === "relayed";
}

/** One `input.resolved` per child batch, each request `cancelled`. */
function withdrawn(requests: readonly OpenRelayed[]): HumanInputEvent[] {
  const batches = new Map<string, OpenRelayed[]>();
  for (const open of requests) {
    const key = batchKey(open);
    batches.set(key, [...(batches.get(key) ?? []), open]);
  }
  return [...batches.values()].map((members) =>
    relayed(
      createInputResolvedEvent({
        ...members[0]!.at,
        resolutions: members.map((open) => ({
          kind: open.request.kind,
          outcome: "cancelled",
          requestId: open.request.requestId,
        })),
      }),
    ),
  );
}

function resolution(open: OpenRelayed, response: InputResponse | undefined): InputResolution {
  const { kind, requestId } = open.request;
  const outcome =
    kind === "tool-approval"
      ? outcomeOf(response)
      : response === undefined
        ? "ignored"
        : "answered";
  return { kind, outcome, requestId, ...(response !== undefined && { response }) };
}

/** A child asks one batch at a time from each source, so its source and coordinates name it. */
function batchKey(open: OpenRelayed): string {
  const { at } = open;
  return JSON.stringify([sourceKey(open.route), at.turnId, at.sequence, at.stepIndex]);
}

function sameSource(a: RelayRoute, b: RelayRoute): boolean {
  return sourceKey(a) === sourceKey(b);
}

/** Children can share a continuation alias, so their own inbox and remote session tell them apart. */
function sourceKey(route: RelayRoute): string {
  return JSON.stringify([
    route.childContinuationToken,
    route.childSessionInbox?.sessionId ?? null,
    route.remote?.sessionId ?? null,
    route.inputSource ?? null,
  ]);
}

function openRelayed(state: HumanInputState): OpenRelayed[] {
  return Object.values(state.requests).filter(isOpenRelayed);
}

function without(state: HumanInputState, retired: readonly OpenRelayed[]): HumanInputState {
  if (retired.length === 0) return state;
  const ids = new Set(retired.map((open) => open.request.requestId));
  return {
    ...state,
    requests: Object.fromEntries(Object.entries(state.requests).filter(([id]) => !ids.has(id))),
  };
}

function relayed(event: Extract<HumanInputEvent, { type: "publish" }>["event"]): HumanInputEvent {
  return { event, relayed: true, type: "publish" };
}
