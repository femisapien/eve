import { readDurableSession } from "#execution/durable-session-store.js";
import {
  relaySessionEvents,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import {
  withSessionStateDelta,
  type SessionStateTransition,
} from "#execution/session/state-delta.js";
import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import { ignoreGoneTarget } from "#execution/tasks/workflow-target.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { getProxyInputRequests } from "#harness/proxy-input-requests.js";
import { sessionView } from "#harness/session-machine/commit.js";
import { finishRun } from "#harness/session-machine/transitions.js";
import { storedProjection } from "#harness/session-machine/view.js";

/**
 * Decides a run's request to withdraw a question. A question the session
 * still offers is retired and relayed `cancelled`, so channels stop offering
 * it. One it no longer offers was already answered or dropped with its turn.
 * Either way the run hears `withdrawn`, after any answer the session sent it
 * first, so the question resolves from the session's first decision.
 */
export async function withdrawWorkflowToolRunQuestionStep(
  input: WithdrawQuestionInput,
): Promise<SessionStateTransition> {
  "use step";
  return await withSessionStateDelta(input, withdrawWorkflowToolRunQuestion);
}

type WithdrawQuestionInput = SessionStepState & {
  readonly control: string;
  readonly requestId: string;
  readonly runId: string;
};

async function withdrawWorkflowToolRunQuestion(
  input: WithdrawQuestionInput,
): Promise<PublishedSessionEvents> {
  const session = readDurableSession(input.sessionState);
  const route = getProxyInputRequests(session.state).get(input.requestId);
  const offered = route?.workflowAsk?.runId === input.runId;
  const withdrawn = offered
    ? finishRun(sessionView(storedProjection(input.serializedContext), session.state), {
        requestIds: [input.requestId],
      })
    : [];
  const decision: WorkflowToolRunControlMessage = {
    kind: "withdrawn",
    requestId: input.requestId,
  };
  await ignoreGoneTarget(resumeHook(input.control, decision));
  return await relaySessionEvents(input, withdrawn);
}
