import type { SessionAuthContext, SubagentInputRequestHookPayload } from "#channel/types.js";
import type {
  ActiveApprovalCandidate,
  ApprovalCandidateDecision,
} from "#harness/approval-candidates.js";
import type { InputRequestEvent } from "#harness/open-approvals.js";
import type { HarnessSessionBase, SessionStateMap } from "#harness/types.js";
import {
  inputOptionSchema,
  type InputOption,
  type InputRequest,
  type InputRequestKind,
} from "#shared/input.js";
import {
  isSessionInboxAddress,
  type SessionInboxAddress,
} from "#execution/session-inbox/address.js";
import type { RemoteAgentBinding } from "#eve-channel/support.js";
import { createInputResolvedEvent, type InputResolvedStreamEvent } from "#protocol/message.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const OPEN_INPUT_REQUESTS_KEY = "eve.runtime.openInputRequests";

const OPEN_INPUT_REQUEST_KINDS = {
  question: true,
  "session-limit": true,
  "tool-approval": true,
} satisfies Readonly<Record<InputRequestKind, true>>;

/**
 * Marks a request as a workflow tool run's `ctx.ask()` question, rather than a
 * child session's. Its answer goes to the run's control hook, which carries
 * every decision the session makes for the run, in order.
 */
export interface WorkflowAskRoute {
  readonly control: string;
  /** What a plain-text message may answer. */
  readonly question: RelayedInputQuestion;
}

/** The parts of a `ctx.ask()` request a plain-text message is resolved against. */
export interface RelayedInputQuestion {
  readonly allowFreeform?: boolean;
  readonly options?: readonly InputOption[];
}

/** Routing and control metadata for one descendant-owned input request. */
export interface RelayedInputRequest {
  readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
  readonly inputSource?: string;
  readonly workflowAsk?: WorkflowAskRoute;
  /**
   * The workflow tool run that relayed the request: its own `ctx.ask()`
   * question, or a request from a session it opened with `ctx.agent`. Nobody
   * can answer the request once that run ends.
   */
  readonly runId?: string;
  /** Batch semantics are optional so sessions written before this field remain routable. */
  readonly batch?: RelayedInputRequestBatch;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  /**
   * Coordinates of the `input.requested` this session emitted for the request;
   * the `input.resolved` it emits once it routes the answer repeats them.
   */
  readonly event: InputRequestEvent;
  readonly kind: InputRequestKind;
  /** Question metadata lets the human-facing parent resolve plain text before proxying by ID. */
  readonly question?: RelayedInputQuestion;
}

export interface RelayedInputRequestBatch {
  readonly approvalRequestIds: readonly string[];
  readonly requestIds: readonly string[];
}

/**
 * A request the turn asked itself, such as its budget question. The turn owns
 * it: the turn answers it, and the turn ending withdraws it.
 */
export interface TurnInputRequest {
  readonly owner: "turn";
  /** Coordinates of the `input.requested` the turn emitted for it. */
  readonly event: InputRequestEvent;
  readonly request: InputRequest;
  /** Auth of the caller whose turn asked; `null` when unauthenticated. */
  readonly requester?: SessionAuthContext | null;
  /** Whether a responder must sign in before their answer counts. */
  readonly responseAuthRequired?: true;
  /** Responders' answers to a tool approval its response policy is still checking. */
  readonly candidates?: Readonly<Record<string, ActiveApprovalCandidate>>;
  /** How many candidates the approval has had, so a retry gets a fresh id. */
  readonly candidateSequence?: number;
  /**
   * The decision that settled the approval. It stays open until every
   * approval in its step is answered; meanwhile a later answer neither starts
   * a candidate for it nor reports it settled again.
   */
  readonly settled?: ApprovalCandidateDecision;
}

/** One open input request, by who answers it. */
export type OpenInputRequest = RelayedInputRequest | TurnInputRequest;

/**
 * The session's open input requests, `requestId → entry`. One table holds
 * every kind: requests relayed for a workflow run or a child session (a
 * {@link RelayedInputRequest}), and the turn's own (a {@link TurnInputRequest}).
 */
type OpenInputRequestMap = Readonly<Record<string, OpenInputRequest>>;

function isTurnRequest(entry: OpenInputRequest): entry is TurnInputRequest {
  return "owner" in entry && entry.owner === "turn";
}

function relayedEntries(map: OpenInputRequestMap): (readonly [string, RelayedInputRequest])[] {
  return Object.entries(map).flatMap(([requestId, entry]) =>
    isTurnRequest(entry) ? [] : [[requestId, entry] as const],
  );
}

/**
 * The requests the session relays for a workflow run or a child session, as a
 * fresh `Map`, so mutating it cannot corrupt session state.
 */
export function readRelayedInputRequests(
  state: SessionStateMap | undefined,
): ReadonlyMap<string, RelayedInputRequest> {
  return new Map(relayedEntries(readMap(state)));
}

/** The requests the turn asked itself. */
export function readTurnInputRequests(
  state: SessionStateMap | undefined,
): ReadonlyMap<string, TurnInputRequest> {
  const entries = new Map<string, TurnInputRequest>();
  for (const [requestId, entry] of Object.entries(readMap(state))) {
    if (isTurnRequest(entry)) entries.set(requestId, entry);
  }
  return entries;
}

/** Opens a request the turn asks itself. */
export function openTurnInputRequest<T extends { readonly state?: SessionStateMap }>(
  session: T,
  entry: Omit<TurnInputRequest, "owner">,
): T {
  return writeMap(session, {
    ...readMap(session.state),
    [entry.request.requestId]: { ...entry, owner: "turn" },
  });
}

/** Replaces the turn's entry for a request; a request no longer open stays closed. */
export function replaceTurnInputRequest(
  state: SessionStateMap | undefined,
  entry: TurnInputRequest,
): SessionStateMap | undefined {
  const map = readMap(state);
  const current = map[entry.request.requestId];
  if (current === undefined || !isTurnRequest(current)) return state;
  return writeMap({ state }, { ...map, [entry.request.requestId]: entry }).state;
}

/**
 * Whether the session relays any request for a workflow run or a child
 * session, so a delivery may carry an answer it has to route.
 */
export function hasRelayedInputRequests(state: SessionStateMap | undefined): boolean {
  return relayedEntries(readMap(state)).length > 0;
}

/**
 * Replaces prior entries for the destination and input source with the provided
 * ones. A child raising a fresh batch overwrites its prior batch so the
 * parent never keeps stale request metadata. Other sources' routes stay
 * independently answerable.
 */
export function upsertRelayedInputRequests<S extends HarnessSessionBase>(input: {
  readonly inputSource?: string;
  readonly entries: readonly (readonly [requestId: string, route: RelayedInputRequest])[];
  readonly forChildContinuationToken: string;
  readonly session: S;
}): S {
  return {
    ...input.session,
    state: upsertRelayedInputRequestState({
      entries: input.entries,
      forChildContinuationToken: input.forChildContinuationToken,
      inputSource: input.inputSource,
      state: input.session.state,
    }),
  };
}

/** State-only variant for control-plane steps that already hold a durable projection. */
export function upsertRelayedInputRequestState(input: {
  readonly inputSource?: string;
  readonly entries: readonly (readonly [requestId: string, route: RelayedInputRequest])[];
  readonly forChildContinuationToken: string;
  readonly state: SessionStateMap | undefined;
}): SessionStateMap | undefined {
  const next: Record<string, OpenInputRequest> = {};

  for (const [requestId, route] of Object.entries(readMap(input.state))) {
    if (
      isTurnRequest(route) ||
      route.childContinuationToken !== input.forChildContinuationToken ||
      route.inputSource !== input.inputSource
    ) {
      next[requestId] = route;
    }
  }

  for (const [requestId, route] of input.entries) {
    next[requestId] = route;
  }

  const state = { ...input.state };
  if (Object.keys(next).length === 0) {
    delete state[OPEN_INPUT_REQUESTS_KEY];
  } else {
    state[OPEN_INPUT_REQUESTS_KEY] = next;
  }
  return Object.keys(state).length > 0 ? state : undefined;
}

/**
 * Retires the requests `select` picks, which nobody can answer anymore, and
 * returns the `input.resolved` events that report them `cancelled` so
 * channels stop offering them. Publish the events as relayed.
 */
export function withdrawRelayedInputRequests<T extends { readonly state?: SessionStateMap }>(
  session: T,
  select: (requestId: string, route: RelayedInputRequest) => boolean,
): { readonly events: readonly InputResolvedStreamEvent[]; readonly session: T } {
  const requestIds: string[] = [];
  const events: InputResolvedStreamEvent[] = [];
  for (const [requestId, route] of relayedEntries(readMap(session.state))) {
    if (!select(requestId, route)) continue;
    requestIds.push(requestId);
    events.push(
      createInputResolvedEvent({
        resolutions: [{ kind: route.kind, outcome: "cancelled", requestId }],
        ...route.event,
      }),
    );
  }
  return { events, session: retireOpenInputRequests(session, requestIds) };
}

/**
 * Retires the requests the turn asked itself, which nobody can answer once
 * the turn ends, and returns the `input.resolved` events that report them
 * `cancelled`. Publish the events as the session's own.
 */
export function withdrawTurnInputRequests<T extends { readonly state?: SessionStateMap }>(
  session: T,
): { readonly events: readonly InputResolvedStreamEvent[]; readonly session: T } {
  const entries = [...readTurnInputRequests(session.state)];
  const events = entries.map(([requestId, entry]) =>
    createInputResolvedEvent({
      resolutions: [{ kind: entry.request.kind, outcome: "cancelled", requestId }],
      ...entry.event,
    }),
  );
  return {
    events,
    session: retireOpenInputRequests(
      session,
      entries.map(([requestId]) => requestId),
    ),
  };
}

/** Removes only the request IDs whose responses were successfully forwarded. */
export function retireOpenInputRequests<T extends { readonly state?: SessionStateMap }>(
  session: T,
  requestIds: readonly string[],
): T {
  const current = readMap(session.state);
  const next = { ...current };
  let changed = false;

  for (const requestId of requestIds) {
    if (Object.hasOwn(next, requestId)) {
      delete next[requestId];
      changed = true;
    }
  }

  return changed ? writeMap(session, next) : session;
}

/**
 * Projects a {@link SubagentInputRequestHookPayload} into the
 * `(requestId, route)` tuples the session stores.
 */
export function toRelayedInputRequests(
  payload: SubagentInputRequestHookPayload,
): readonly (readonly [requestId: string, route: RelayedInputRequest])[] {
  const batch: RelayedInputRequestBatch = {
    approvalRequestIds: payload.event.requests.flatMap((request) =>
      request.kind === "tool-approval" ? [request.requestId] : [],
    ),
    requestIds: payload.event.requests.map((request) => request.requestId),
  };
  const event: InputRequestEvent = {
    sequence: payload.event.sequence,
    stepIndex: payload.event.stepIndex,
    turnId: payload.event.turnId,
  };
  return payload.event.requests.map((request) => {
    const route: {
      readonly childContinuationToken: string;
      readonly inputSource?: string;
      readonly remote?: RemoteAgentBinding & { readonly sessionId: string };
      childSessionInbox?: SessionInboxAddress;
      readonly event: InputRequestEvent;
      readonly kind: InputRequestKind;
      question?: RelayedInputQuestion;
    } & { readonly batch: RelayedInputRequestBatch } = {
      batch,
      childContinuationToken: payload.childContinuationToken,
      ...(payload.inputSource !== undefined && { inputSource: payload.inputSource }),
      ...(payload.remote !== undefined && { remote: payload.remote }),
      event,
      kind: request.kind,
    };
    if (request.kind === "question") {
      route.question = {
        ...(request.allowFreeform !== undefined && { allowFreeform: request.allowFreeform }),
        ...(request.options !== undefined && { options: [...request.options] }),
      };
    }
    if (payload.childSessionInbox?.sessionId === payload.childSessionId) {
      route.childSessionInbox = payload.childSessionInbox;
    }

    return [request.requestId, route] as const;
  });
}

function readMap(state: SessionStateMap | undefined): OpenInputRequestMap {
  const raw = state?.[OPEN_INPUT_REQUESTS_KEY];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }

  const result: Record<string, OpenInputRequest> = {};
  for (const [key, value] of Object.entries(raw)) {
    const request = parseTurnInputRequest(value) ?? parseRelayedInputRequest(value, key);
    if (request !== undefined) {
      result[key] = request;
    }
  }
  return result;
}

function writeMap<T extends { readonly state?: SessionStateMap }>(
  session: T,
  entries: Record<string, OpenInputRequest>,
): T {
  const state = { ...session.state };

  if (Object.keys(entries).length === 0) {
    delete state[OPEN_INPUT_REQUESTS_KEY];
    return {
      ...session,
      state: Object.keys(state).length > 0 ? state : undefined,
    };
  }

  state[OPEN_INPUT_REQUESTS_KEY] = entries;
  return { ...session, state };
}

function parseTurnInputRequest(value: unknown): TurnInputRequest | undefined {
  if (value === null || typeof value !== "object" || Reflect.get(value, "owner") !== "turn") {
    return undefined;
  }
  const event = parseInputRequestEvent(Reflect.get(value, "event"));
  const request: unknown = Reflect.get(value, "request");
  if (event === undefined || request === null || typeof request !== "object") return undefined;
  if (
    typeof Reflect.get(request, "requestId") !== "string" ||
    !isInputRequestKind(Reflect.get(request, "kind"))
  ) {
    return undefined;
  }
  const entry: Mutable<TurnInputRequest> = {
    event,
    owner: "turn",
    request: request as InputRequest,
  };
  const requester: unknown = Reflect.get(value, "requester");
  if (typeof requester === "object") entry.requester = requester as SessionAuthContext | null;
  if (Reflect.get(value, "responseAuthRequired") === true) entry.responseAuthRequired = true;
  const candidates: unknown = Reflect.get(value, "candidates");
  if (candidates !== null && typeof candidates === "object" && !Array.isArray(candidates)) {
    entry.candidates = candidates as Readonly<Record<string, ActiveApprovalCandidate>>;
  }
  const candidateSequence: unknown = Reflect.get(value, "candidateSequence");
  if (Number.isSafeInteger(candidateSequence) && (candidateSequence as number) >= 0) {
    entry.candidateSequence = candidateSequence as number;
  }
  const settled: unknown = Reflect.get(value, "settled");
  if (settled === "approve" || settled === "cancel") entry.settled = settled;
  return entry;
}

function parseRelayedInputRequest(
  value: unknown,
  requestId: string,
): RelayedInputRequest | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  if (!("childContinuationToken" in value) || !("kind" in value)) {
    return undefined;
  }
  if (typeof value.childContinuationToken !== "string" || !isInputRequestKind(value.kind)) {
    return undefined;
  }
  const remote = "remote" in value ? parseRemoteAgentBinding(value.remote) : undefined;
  if ("remote" in value && remote === undefined) return undefined;
  const inputSource = "inputSource" in value ? value.inputSource : undefined;
  if (inputSource !== undefined && (typeof inputSource !== "string" || inputSource.length === 0))
    return undefined;
  const event = "event" in value ? parseInputRequestEvent(value.event) : undefined;
  if (event === undefined) return undefined;
  const batch = "batch" in value ? parseRelayedInputRequestBatch(value.batch) : undefined;
  const workflowAsk = "workflowAsk" in value ? parseWorkflowAskRoute(value.workflowAsk) : undefined;
  if ("workflowAsk" in value && workflowAsk === undefined) return undefined;
  const runId = "runId" in value ? value.runId : undefined;
  if (runId !== undefined && (typeof runId !== "string" || runId.length === 0)) return undefined;
  const question = "question" in value ? parseRelayedInputQuestion(value.question) : undefined;
  if ("question" in value && question === undefined) return undefined;
  const childSessionInbox = "childSessionInbox" in value ? value.childSessionInbox : undefined;
  if (childSessionInbox !== undefined && !isSessionInboxAddress(childSessionInbox))
    return undefined;
  const request: {
    workflowAsk?: WorkflowAskRoute;
    runId?: string;
    batch?: RelayedInputRequestBatch;
    readonly childContinuationToken: string;
    inputSource?: string;
    remote?: RemoteAgentBinding & { readonly sessionId: string };
    childSessionInbox?: SessionInboxAddress;
    readonly event: InputRequestEvent;
    readonly kind: InputRequestKind;
    question?: RelayedInputQuestion;
  } = {
    childContinuationToken: value.childContinuationToken,
    event,
    kind: value.kind,
  };
  if (typeof inputSource === "string") request.inputSource = inputSource;
  if (remote !== undefined) request.remote = remote;
  if (workflowAsk !== undefined) request.workflowAsk = workflowAsk;
  if (typeof runId === "string") request.runId = runId;
  if (childSessionInbox !== undefined) request.childSessionInbox = childSessionInbox;
  if (batch !== undefined && batch.requestIds.includes(requestId)) request.batch = batch;
  if (question !== undefined) request.question = question;
  return request;
}

function parseInputRequestEvent(value: unknown): InputRequestEvent | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const sequence = Reflect.get(value, "sequence");
  const stepIndex = Reflect.get(value, "stepIndex");
  const turnId = Reflect.get(value, "turnId");
  if (typeof sequence !== "number" || typeof stepIndex !== "number") return undefined;
  if (typeof turnId !== "string") return undefined;
  return { sequence, stepIndex, turnId };
}

function parseWorkflowAskRoute(value: unknown): WorkflowAskRoute | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const control = Reflect.get(value, "control");
  if (typeof control !== "string" || control.length === 0) return undefined;
  const question = parseRelayedInputQuestion(Reflect.get(value, "question"));
  if (question === undefined) return undefined;
  return { control, question };
}

function parseRemoteAgentBinding(
  value: unknown,
): (RemoteAgentBinding & { readonly sessionId: string }) | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const name = Reflect.get(value, "name");
  const url = Reflect.get(value, "url");
  const resolverId = Reflect.get(value, "resolverId");
  const forwardPrincipal = Reflect.get(value, "forwardPrincipal");
  const sessionId = Reflect.get(value, "sessionId");
  if (
    typeof name !== "string" ||
    !name ||
    typeof url !== "string" ||
    !url ||
    typeof sessionId !== "string" ||
    !sessionId
  )
    return undefined;
  if (resolverId !== undefined && (typeof resolverId !== "string" || !resolverId)) return undefined;
  if (forwardPrincipal !== undefined && typeof forwardPrincipal !== "boolean") return undefined;
  return {
    name,
    url,
    sessionId,
    ...(resolverId !== undefined && { resolverId }),
    ...(forwardPrincipal !== undefined && { forwardPrincipal }),
  };
}

function parseRelayedInputQuestion(value: unknown): RelayedInputQuestion | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const question: {
    allowFreeform?: boolean;
    options?: readonly InputOption[];
  } = {};
  const allowFreeform = Reflect.get(value, "allowFreeform");
  if (allowFreeform !== undefined) {
    if (typeof allowFreeform !== "boolean") return undefined;
    question.allowFreeform = allowFreeform;
  }
  const options = Reflect.get(value, "options");
  if (options !== undefined) {
    const parsed = inputOptionSchema.array().safeParse(options);
    if (!parsed.success) return undefined;
    question.options = parsed.data;
  }
  return question;
}

function parseRelayedInputRequestBatch(value: unknown): RelayedInputRequestBatch | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!("approvalRequestIds" in value) || !("requestIds" in value)) return undefined;
  if (!isStringArray(value.approvalRequestIds) || !isStringArray(value.requestIds))
    return undefined;
  const requestIds = new Set(value.requestIds);
  if (
    requestIds.size !== value.requestIds.length ||
    value.approvalRequestIds.some((requestId) => !requestIds.has(requestId))
  ) {
    return undefined;
  }
  return { approvalRequestIds: value.approvalRequestIds, requestIds: value.requestIds };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isInputRequestKind(value: unknown): value is InputRequestKind {
  return typeof value === "string" && Object.hasOwn(OPEN_INPUT_REQUEST_KINDS, value);
}
