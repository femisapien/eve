import type { ModelMessage } from "ai";

import type { AuthorizationChallenge } from "#harness/authorization.js";
import { readRuntimeWaitingStep } from "#harness/coordination.js";
import { runApprovedCalls } from "#harness/hitl/approved-calls.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
import { isApprovalRequest } from "#harness/input-request-class.js";
import {
  readTurnState,
  replaceSuspendedStep,
  settleSuspendedStep,
  stepCallIds,
  type StepCoordinates,
} from "#harness/turn-state.js";
import type { HarnessEmitFn, HarnessSession, HarnessToolMap } from "#harness/types.js";
import { collectDeferredCalls } from "#harness/workflow-dispatch.js";
import type { InputRequest } from "#shared/input.js";

/**
 * What running a delivery's approved work left: `continue` when the model can
 * read every result; `runtime` when approved workflow calls joined the runs the
 * step waits on; `sign-in` when an approved call needs a sign-in first.
 * `commit` is the step's response, once every call it made has a result.
 */
export type ApprovedWorkOutcome =
  | {
      readonly kind: "continue";
      readonly commit: readonly ModelMessage[];
      readonly session: HarnessSession;
    }
  | {
      readonly kind: "runtime";
      readonly commit: readonly ModelMessage[];
      readonly session: HarnessSession;
    }
  | {
      readonly kind: "sign-in";
      readonly challenges: readonly AuthorizationChallenge[];
      readonly commit: readonly ModelMessage[];
      readonly session: HarnessSession;
    };

/**
 * Runs what a delivery approved, in the turn it resumed. eve runs approved
 * local calls itself, with the tools of the step that asked; approved workflow
 * calls join the runs the step waits on. An approved call that needs a sign-in
 * leaves the step, so the model calls it again once the sign-in completes.
 */
export async function runApprovedWork(input: {
  readonly abortSignal: AbortSignal | undefined;
  /** Where the calls' events sit in the stream. */
  readonly at: StepCoordinates;
  readonly emit: HarnessEmitFn | undefined;
  /** The conversation the tools read as `ctx.messages`. */
  readonly messages: readonly ModelMessage[];
  readonly resolvedInputs: readonly ResolvedInputBatch[];
  readonly session: HarnessSession;
  /** The tools of the step that asked. */
  readonly tools: HarnessToolMap;
}): Promise<ApprovedWorkOutcome> {
  const answered = input.resolvedInputs.flatMap((batch) =>
    batch.inputs.flatMap((entry) => (isApprovalRequest(entry.request) ? [entry] : [])),
  );
  const step = readTurnState(input.session.state).suspended.find(
    (candidate) =>
      candidate.requests.length === 0 &&
      answered.some((entry) => stepCallIds(candidate).has(entry.request.action.callId)),
  );
  if (step === undefined) return { commit: [], kind: "continue", session: input.session };
  const approved = answered.flatMap((entry) =>
    entry.outcome === "approved" ? [entry.request] : [],
  );
  for (const request of approved) {
    if (!input.tools.has(request.action.toolName)) {
      throw new Error(
        "The approved tool is no longer available. Request a new tool call and approval.",
      );
    }
  }
  const runsInRuntime = (request: InputRequest) =>
    input.tools.get(request.action.toolName)?.workflowId !== undefined;
  const executed = await runApprovedCalls({
    abortSignal: input.abortSignal,
    at: input.at,
    emit: input.emit,
    messages: input.messages,
    requests: approved.filter((request) => !runsInRuntime(request)),
    tools: input.tools,
  });
  const signIn = resolveInlineAuthorizationInterrupt({
    messages: step.messages,
    toolResults: executed.toolResults,
  });
  const workflowCalls = approved.filter(runsInRuntime);
  const deferred = collectDeferredCalls({
    session: input.session,
    toolCalls: workflowCalls.map(({ action }) => ({
      input: action.input,
      toolCallId: action.callId,
      toolName: action.toolName,
    })),
    tools: input.tools,
    turnId: step.event.turnId,
  });
  const settled = settleSuspendedStep(
    replaceSuspendedStep(deferred.session, step, {
      ...step,
      messages: signIn?.history ?? step.messages,
      tasks: [...step.tasks, ...deferred.workflowRequests],
    }),
    executed.settled,
  );
  if (signIn !== undefined) {
    return {
      challenges: signIn.challenges,
      commit: settled.commit,
      kind: "sign-in",
      session: settled.session,
    };
  }
  const kind = readRuntimeWaitingStep(settled.session.state) === undefined ? "continue" : "runtime";
  return { commit: settled.commit, kind, session: settled.session };
}
