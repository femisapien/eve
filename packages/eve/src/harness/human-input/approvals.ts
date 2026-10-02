import type { ModelMessage, ToolResultPart } from "ai";

import { resolveTextToResponses } from "#channel/resolve-text.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  createActionResultEvent,
  createInputRequestedEvent,
  createInputResolvedEvent,
  type InputResolution,
} from "#protocol/message.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

import type { HumanInputEvent, RequestAt } from "./index.js";

// The tool approval rules. A model step's calls open one request each; the
// step's approvals resolve together once each has an answer, or when the turn
// moves past them. Approved calls run in the runtime (`calls.approved`); every
// other call gets a not-run result, so history always answers the step's calls.

/** An open approval, as the session stores it. */
export interface OpenApproval {
  readonly kind: "tool-approval";
  readonly at: RequestAt;
  readonly request: InputRequest;
  readonly requester: SessionAuthContext | null;
  /** What a `once()` approval grants: the tool's approval key, else its name. */
  readonly approvalKey: string;
  /** An answer that arrived before the rest of the step's approvals were answered. */
  readonly answer?: InputResponse;
}

/** The state the approval rules read and change. */
interface ApprovalState {
  readonly requests: Readonly<Record<string, { readonly kind: string }>>;
  readonly grants: readonly string[];
}

interface Reduced<S> {
  readonly events: readonly HumanInputEvent[];
  readonly state: S;
}

type Outcome = "approved" | "denied" | "invalid" | "ignored";

const NOT_RUN_REASONS: Record<Exclude<Outcome, "approved"> | "cancelled", string> = {
  cancelled: "Cancelled before anyone answered.",
  denied: "Tool execution was denied.",
  ignored: "Ignored because the user continued without responding.",
  invalid: "Invalid approval response.",
};

/** A model step's calls ask for approval: each becomes an open request, and the turn holds. */
export function openApprovals<S extends ApprovalState>(
  state: S,
  input: {
    readonly at: RequestAt;
    readonly requests: readonly InputRequest[];
    readonly requester: SessionAuthContext | null;
    readonly approvalKeys: Readonly<Record<string, string>>;
  },
): Reduced<S> {
  // Every anonymous caller shares one identity, so an anonymous requester
  // can't be told apart from another anonymous person: record none.
  const requester = input.requester?.principalType === "anonymous" ? null : input.requester;
  const requests: Record<string, { readonly kind: string }> = { ...state.requests };
  for (const request of input.requests) {
    const approval: OpenApproval = {
      approvalKey: input.approvalKeys[request.requestId] ?? request.action.toolName,
      at: input.at,
      kind: "tool-approval",
      request,
      requester,
    };
    requests[request.requestId] = approval;
  }
  return {
    events: [publish(createInputRequestedEvent({ ...input.at, requests: input.requests }))],
    state: { ...state, requests },
  };
}

/**
 * Answers arrived. Each answers its open approval, the last one winning; the
 * step's approvals resolve once every one has an answer. Until then the
 * answers wait in state and the turn stays held.
 */
export function answerApprovals<S extends ApprovalState>(
  state: S,
  responses: readonly InputResponse[],
): Reduced<S> {
  const recorded = recordAnswers(state, responses);
  const open = openApprovalsOf(recorded);
  if (open.length === 0 || open.some((approval) => approval.answer === undefined)) {
    return { events: [], state: recorded };
  }
  return resolveApprovals(recorded);
}

/**
 * A message arrived while approvals wait. Plain text that matches their
 * options answers the approvals it matches, and the turn doesn't read it. Any
 * other message steers the turn past them: the approvals nobody answered are
 * ignored, and the answers already given stand.
 *
 * Only the turn's own person reaches a held turn with a message; the runtime
 * queues anyone else's for the next turn.
 */
export function receiveMessage<S extends ApprovalState>(state: S, text: string): Reduced<S> {
  const open = openApprovalsOf(state);
  if (open.length === 0) return { events: [], state };
  const typed = resolveTextToResponses(
    text,
    open.filter((approval) => approval.answer === undefined).map((approval) => approval.request),
  );
  if (typed.length === 0) return resolveApprovals(state);
  const answered = answerApprovals(state, typed);
  return { ...answered, events: [{ type: "message.answered" }, ...answered.events] };
}

/** The turn was cancelled: every open approval is cancelled, and its call never runs. */
export function cancelApprovals<S extends ApprovalState>(state: S): Reduced<S> {
  const open = openApprovalsOf(state);
  if (open.length === 0) return { events: [], state };
  const events: HumanInputEvent[] = open.map((approval) =>
    publish(
      createInputResolvedEvent({
        ...approval.at,
        resolutions: [
          {
            kind: approval.request.kind,
            outcome: "cancelled",
            requestId: approval.request.requestId,
          },
        ],
      }),
    ),
  );
  events.push({
    message: notRunMessage(open.map((approval) => notRunPart(approval, "cancelled"))),
    type: "history.appended",
  });
  return { events, state: { ...state, requests: withoutApprovals(state.requests) } };
}

/** The runtime ran the approved calls: their results join history, and the turn goes on. */
export function settleCalls<S extends ApprovalState>(
  state: S,
  results: readonly ModelMessage[],
): Reduced<S> {
  return { events: results.map((message) => ({ message, type: "history.appended" })), state };
}

/**
 * The approval keys `once()` approvals granted, for approval policies to read.
 * A grant is hidden while an approval for its key still waits, so the policy
 * keeps asking for that call.
 */
export function grantedApprovalKeys(state: ApprovalState): ReadonlySet<string> {
  const waiting = new Set(openApprovalsOf(state).map((approval) => approval.approvalKey));
  return new Set(state.grants.filter((key) => !waiting.has(key)));
}

/**
 * Resolves the step's approvals together: one `input.resolved` at the asking
 * step, a not-run result and a rejected `action.result` for each call that
 * won't run, and `calls.approved` for the rest. An approval nobody answered
 * is ignored.
 */
function resolveApprovals<S extends ApprovalState>(state: S): Reduced<S> {
  const open = openApprovalsOf(state);
  const resolutions: InputResolution[] = [];
  const notRun: ToolResultPart[] = [];
  const rejected: HumanInputEvent[] = [];
  const approved: InputRequest[] = [];
  const grants = new Set(state.grants);
  for (const approval of open) {
    const outcome = outcomeOf(approval.answer);
    resolutions.push({
      kind: approval.request.kind,
      outcome,
      requestId: approval.request.requestId,
      ...(approval.answer !== undefined && { response: approval.answer }),
    });
    if (outcome === "approved") {
      approved.push(approval.request);
      grants.add(approval.approvalKey);
      continue;
    }
    notRun.push(notRunPart(approval, outcome));
    rejected.push(
      publish(
        createActionResultEvent({
          ...approval.at,
          rejected: true,
          result: {
            callId: approval.request.action.callId,
            isError: true,
            kind: "tool-result",
            output: {
              approval: { requestId: approval.request.requestId, status: outcome },
              code: "TOOL_EXECUTION_DENIED",
              message: NOT_RUN_REASONS[outcome],
              tool: { result: "not_run" },
            },
            toolName: approval.request.action.toolName,
          },
        }),
      ),
    );
  }
  // At most one step has open approvals, so they share its coordinates.
  const at = open[0]!.at;
  const events: HumanInputEvent[] = [
    publish(createInputResolvedEvent({ ...at, resolutions })),
    ...rejected,
  ];
  if (notRun.length > 0) events.push({ message: notRunMessage(notRun), type: "history.appended" });
  if (approved.length > 0) events.push({ at, requests: approved, type: "calls.approved" });
  return {
    events,
    state: { ...state, grants: [...grants], requests: withoutApprovals(state.requests) },
  };
}

/** An approval's outcome from its answer; a relayed approval resolves the same way. */
export function outcomeOf(answer: InputResponse | undefined): Outcome {
  if (answer === undefined) return "ignored";
  if (answer.optionId === "approve") return "approved";
  // ACP answers with "deny"; eve's own approval prompts offer "cancel".
  if (answer.optionId === "cancel" || answer.optionId === "deny") return "denied";
  return "invalid";
}

function recordAnswers<S extends ApprovalState>(state: S, responses: readonly InputResponse[]): S {
  const requests: Record<string, { readonly kind: string }> = { ...state.requests };
  for (const response of responses) {
    const open = requests[response.requestId];
    if (!isOpenApproval(open)) continue;
    const answered: OpenApproval = { ...open, answer: response };
    requests[response.requestId] = answered;
  }
  return { ...state, requests };
}

function openApprovalsOf(state: ApprovalState): OpenApproval[] {
  return Object.values(state.requests).filter(isOpenApproval);
}

function isOpenApproval(value: { readonly kind: string } | undefined): value is OpenApproval {
  return value?.kind === "tool-approval";
}

function withoutApprovals<R extends { readonly kind: string }>(
  requests: Readonly<Record<string, R>>,
): Readonly<Record<string, R>> {
  return Object.fromEntries(
    Object.entries(requests).filter(([, request]) => !isOpenApproval(request)),
  );
}

function notRunPart(approval: OpenApproval, outcome: keyof typeof NOT_RUN_REASONS): ToolResultPart {
  return {
    output: { reason: NOT_RUN_REASONS[outcome], type: "execution-denied" },
    toolCallId: approval.request.action.callId,
    toolName: approval.request.action.toolName,
    type: "tool-result",
  };
}

function notRunMessage(parts: readonly ToolResultPart[]): ModelMessage {
  return { content: [...parts], role: "tool" };
}

function publish(event: Extract<HumanInputEvent, { type: "publish" }>["event"]): HumanInputEvent {
  return { event, type: "publish" };
}
