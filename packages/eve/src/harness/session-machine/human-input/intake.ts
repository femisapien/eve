import type { ModelMessage, ToolSet, TypedToolResult } from "ai";

import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import { collectDeferredCalls } from "#harness/coordination.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import type { ResolvedInputBatch } from "#harness/input-request-resolution.js";
import { createTurnInputMessages } from "#harness/messages.js";
import { stepStartedForResolvers } from "#harness/session-machine/resolver-events.js";
import {
  completeSignIn,
  finishTurn,
  settle,
  type SettledCall,
} from "#harness/session-machine/transitions.js";
import type { SuspendedStep } from "#harness/session-machine/view.js";
import { openTurn, type Step } from "#harness/step/context.js";
import { SessionLimitDeclinedError } from "#harness/turn-cancellation.js";
import { bumpSessionRuntimeUsageLimits } from "#harness/turn-tag-state.js";
import type { HarnessToolMap, StepInput, StepResult } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest } from "#shared/input.js";
import { answer, approvingSteps, dispatch, requireSignIn, stepForRequest } from "./approvals.js";
import { runApprovedCalls } from "./approved-calls.js";
import { getApprovalAuditState } from "./candidates.js";
import { coordinateApprovalDelivery } from "./coordinator.js";
import { deliver } from "./delivery.js";

/**
 * What a delivery does before its turn runs. `stop` ends the step: the answers left nothing to
 * run yet, or a responder must sign in first. `run` carries the turn's input, without the answers
 * the session took, and the approved work that runs once the turn opens.
 */
export type HumanInputIntake =
  | { readonly kind: "stop"; readonly result: StepResult }
  | {
      readonly kind: "run";
      readonly input: StepInput | undefined;
      /** The message the turn receives, as the stream shows it. */
      readonly message?: StepInput["message"];
      /** A plain-text answer consumed the message, so the model never reads it. */
      readonly consumedMessage: boolean;
      /** The delivery carries input for a turn. */
      readonly opensTurn: boolean;
      readonly approved: ApprovedWork;
    };

/** What the delivery approved: it runs in the turn the delivery opens. */
export interface ApprovedWork {
  readonly resolved: readonly ResolvedInputBatch[];
  readonly limit?: { readonly granted: boolean };
  /** The tools a parked step's calls run with: those of the turn that asked. */
  readonly toolsOf: (step: SuspendedStep | undefined) => HarnessToolMap;
}

/**
 * Answers what the session asked: approval answers pass the response policies, and the session
 * decides which parked steps they resolve. Runs before the delivery opens a turn, so approved
 * calls get the tools of the turn that asked.
 */
export async function acceptHumanInput(
  step: Step,
  input: StepInput | undefined,
  options: { readonly takeQueued: boolean },
): Promise<HumanInputIntake> {
  const { config, ctx } = step;
  // A sign-in completes first, at the coordinates of the turn that asked. Between turns, a
  // connection's sign-in resumes that work in a turn of its own.
  const completions = config.signInCompletions ?? [];
  const resumesSignIn =
    completions.some((challenge) => challenge.candidateId === undefined) &&
    step.view().projection.activeTurnId === undefined;
  if (completions.length > 0) await step.apply(completeSignIn(step.view(), { completions }));
  const delivered = deliver(step.view(), input, options);
  // Restoring a turn's tools runs its resolvers, so a step's tools are restored once, and again
  // only after another step's.
  const restoredTools = new Map<string, HarnessToolMap>();
  let restoredStep: string | undefined;
  const restoreTools = async (parked: SuspendedStep | undefined): Promise<HarnessToolMap> => {
    const at = parked?.event ?? step.position();
    const key = `${at.turnId}:${at.stepIndex}`;
    const restored = restoredTools.get(key);
    if (restored !== undefined && restoredStep === key) return restored;
    if (parked !== undefined) await config.prepareApprovalTurn?.(parked.event);
    if (ctx !== undefined) {
      await config.resolveStepDynamicTools?.({
        ctx,
        event: stepStartedForResolvers({
          modelId: step.session.agent.modelReference?.id ?? "dynamic",
          sequence: at.sequence,
          stepIndex: at.stepIndex,
          turnId: at.turnId,
        }),
        messages: step.projectHistory(step.session.history),
      });
    }
    const tools = buildResponseAuthorizationTools({ authoredTools: config.tools, context: ctx });
    restoredTools.set(key, tools);
    restoredStep = key;
    return tools;
  };
  const toolsOf = (parked: SuspendedStep | undefined) =>
    (parked && restoredTools.get(`${parked.event.turnId}:${parked.event.stepIndex}`)) ??
    config.tools;

  const challengesAtStart = step.view().signIns;
  const coordinated = await coordinateApprovalDelivery({
    session: step.session,
    stepInput: delivered.input,
    tools: config.tools,
    prepareTools: (request) => restoreTools(stepForRequest(step.view(), request.requestId)),
  });
  step.session = coordinated.session;

  for (const parked of approvingSteps(step.view(), coordinated.stepInput)) {
    await restoreTools(parked);
  }
  const decision = answer(step.view(), {
    approvalKey: (request) =>
      toolsOf(stepForRequest(step.view(), request.requestId))
        .get(request.action.toolName)
        ?.approvalKey?.(request.action.input),
    delivery: coordinated.stepInput,
    policy: {
      ...coordinated,
      audit: getApprovalAuditState(step.session.state),
      challengesAtStart,
    },
    takeQueued: delivered.takeQueued,
  });
  for (const batch of decision.resolved) {
    await step.instrumentation?.publishInputResolutions({
      batch,
      sessionId: step.session.sessionId,
    });
  }
  await step.apply(decision);
  const stop = (): HumanInputIntake => ({
    kind: "stop",
    result: { next: null, session: step.session },
  });
  switch (decision.next) {
    case "park":
      return stop();
    case "repeat":
      return { kind: "stop", result: { next: step.runStep, session: step.session } };
    case "sign-in":
      await step.apply(
        requireSignIn(step.view(), {
          challenges: coordinated.challenges,
          queued: coordinated.stepInput,
        }),
      );
      return stop();
    case "defer-message": {
      // The message is received, and waits, queued, for the open prompt.
      const failed = await openTurn(step, {
        input: createTurnInputMessages(delivered.input ?? {}),
        message: delivered.displayMessage ?? delivered.input?.message,
      });
      if (failed !== undefined) return { kind: "stop", result: failed };
      await step.apply(finishTurn(step.view()), step.session.history);
      return stop();
    }
    case "continue":
      break;
  }
  return {
    approved: { limit: decision.limit, resolved: decision.resolved, toolsOf },
    consumedMessage: decision.consumedMessage === true,
    input: decision.input,
    message: delivered.displayMessage ?? delivered.input?.message,
    kind: "run",
    opensTurn:
      resumesSignIn || hasTurnInput(delivered.input) || hasTurnInput(coordinated.stepInput),
  };
}

/**
 * Runs what a delivery approved, in the turn it opened. A session-limit answer grants a fresh
 * budget or ends the turn tree. eve runs approved calls itself before the model reads their
 * results, each step's with the tools of its turn; approved workflow calls join the runs their
 * steps wait on, and the turn's own input waits with them (`following`).
 */
export async function runApprovedWork(
  step: Step,
  work: ApprovedWork,
  following: readonly ModelMessage[],
): Promise<StepResult | undefined> {
  if (work.limit !== undefined) {
    if (!work.limit.granted) throw new SessionLimitDeclinedError();
    step.session = bumpSessionRuntimeUsageLimits(step.session);
  }

  const toolResults: TypedToolResult<ToolSet>[] = [];
  const settled: SettledCall[] = [];
  const workflowCalls: { tools: HarnessToolMap; turnId: string; requests: InputRequest[] }[] = [];
  for (const batch of work.resolved) {
    const approved = batch.inputs.filter((entry) => entry.outcome === "approved");
    if (approved.length === 0) continue;
    const tools = work.toolsOf(
      step
        .view()
        .turn.suspended.find(
          (parked) =>
            parked.event.turnId === batch.event.turnId &&
            parked.event.stepIndex === batch.event.stepIndex,
        ),
    );
    for (const { request } of approved) {
      if (!tools.has(request.action.toolName)) {
        throw new Error(
          "The approved tool is no longer available. Request a new tool call and approval.",
        );
      }
    }
    const requests = approved.map((entry) => entry.request);
    const isWorkflowCall = (request: InputRequest) =>
      tools.get(request.action.toolName)?.workflowId !== undefined;
    const executed = await runApprovedCalls({
      abortSignal: step.config.abortSignal,
      messages: step.projectHistory(step.session.history),
      position: step.position(),
      publish: step.publish,
      requests: requests.filter((request) => !isWorkflowCall(request)),
      tools,
    });
    settled.push(...executed.settled);
    toolResults.push(...executed.toolResults);
    workflowCalls.push({
      requests: requests.filter(isWorkflowCall),
      tools,
      turnId: batch.event.turnId,
    });
  }
  // Denied calls already hold their results, so a step they complete commits here too.
  await step.apply(settle(step.view(), { results: settled }));
  const signIn = resolveInlineAuthorizationInterrupt({ messages: [], toolResults });
  if (signIn !== undefined) {
    await step.apply(
      requireSignIn(step.view(), {
        callIdsByName: signIn.callIdsByName,
        challenges: signIn.challenges,
      }),
      step.session.history,
    );
    return { next: null, session: step.session };
  }
  const tasks: RuntimeWorkflowTaskRequest[] = [];
  for (const { requests, tools, turnId } of workflowCalls) {
    if (requests.length === 0) continue;
    const deferred = collectDeferredCalls({
      session: step.session,
      toolCalls: requests.map(({ action }) => ({
        input: action.input,
        toolCallId: action.callId,
        toolName: action.toolName,
      })),
      tools,
      turnId,
    });
    step.session = deferred.session;
    tasks.push(...deferred.workflowRequests);
  }
  if (tasks.length > 0) await step.apply(dispatch(step.view(), { following, tasks }));
  return undefined;
}

/** Whether the input carries user-facing turn input. */
function hasTurnInput(input: StepInput | undefined): boolean {
  if (input === undefined) return false;
  return input.message !== undefined || (input.inputResponses?.length ?? 0) > 0;
}
