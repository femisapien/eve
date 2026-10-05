import { getApprovedTools } from "./input-requests.js";
import { approvalKeyResolver } from "./intake.js";
import { buildResponseAuthorizationTools } from "#context/build-dynamic-tools.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import type { InstrumentationAttempt } from "#instrumentation/runtime.js";
import { validateHarnessModelMessages, type HarnessModelMessage } from "#harness/messages.js";
import type { Step } from "#harness/step/context.js";
import type { StepResult } from "#harness/types.js";
import { runApprovedCalls } from "./approved-calls.js";
import { unfinishedApprovals, settleApprovedTranscript } from "./approved-transcript.js";
import { stopForToolSignIn } from "./sign-in.js";

/**
 * Old-engine bridge: execute after step start/budget, before the model reads the results. The
 * calls run in the step's first attempt, as the AI SDK ran them before its model call.
 */
export async function executeApprovedLocalCalls(
  step: Step,
  messages: readonly HarnessModelMessage[],
  setAttemptScope: (scope: InstrumentationAttempt | undefined) => void,
): Promise<{ readonly messages: HarnessModelMessage[]; readonly held?: StepResult }> {
  const tools = buildResponseAuthorizationTools({
    authoredTools: step.config.tools,
    context: step.ctx,
  });
  const requests = unfinishedApprovals(messages).filter(
    (request) => tools.get(request.action.toolName)?.workflowId === undefined,
  );
  if (requests.length === 0) return { messages: [...messages] };
  const position = step.position();
  const attempt = step.instrumentation?.prepareAttempt({
    attemptIndex: 0,
    stepIndex: position.stepIndex,
    turnId: activeTurnId(position),
  });
  setAttemptScope(attempt?.scope);
  const executed = await runApprovedCalls({
    requests,
    tools,
    approvedTools: getApprovedTools(step.session, approvalKeyResolver(tools)),
    messages: step.projectHistory(messages),
    position: step.position(),
    publish: step.emit ?? (async () => {}),
    abortSignal: step.config.abortSignal,
    telemetry: attempt?.telemetry,
  });
  const transcript = validateHarnessModelMessages(
    settleApprovedTranscript(messages, requests, executed.settled),
  );
  const held = await stopForToolSignIn(step, {
    messages: transcript,
    position: step.position(),
    toolResults: executed.toolResults,
  });
  if (held !== undefined) return { messages: transcript, held };
  step.session = { ...step.session, history: transcript };
  return { messages: transcript };
}
