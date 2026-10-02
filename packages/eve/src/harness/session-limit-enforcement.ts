/**
 * Session token and token-cost limit policy for the tool-loop harness.
 *
 * {@link enforceSessionUsageLimit} runs before each model call. Over budget,
 * a turn that can reach a person holds on a budget question it owns (see
 * `session-limit-request`); a turn that can't fails with
 * `SESSION_TOKEN_LIMIT_REACHED` (or the cost variant).
 */
import { createInputRequestedEvent, createTurnWaitingEvent } from "#protocol/message.js";
import {
  advanceStep,
  emitFailedStep,
  setHarnessEmissionState,
  type HarnessEmissionState,
} from "#harness/emission.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import { createSessionLimitContinuationRequest } from "#harness/session-limit-continuation.js";
import {
  openSessionLimitRequest,
  readSessionLimitRequest,
  sessionLimitRequestAt,
} from "#harness/session-limit-request.js";
import {
  getSessionUsageLimitViolation,
  getSessionTokenUsage,
  getSessionUsage,
  type SessionUsageLimitViolation,
} from "#harness/turn-tag-state.js";
import type { HarnessSession, StepResult, ToolLoopHarnessConfig } from "#harness/types.js";

const SESSION_TOKEN_LIMIT_REACHED_CODE = "SESSION_TOKEN_LIMIT_REACHED";
const SESSION_TOKEN_COST_LIMIT_REACHED_CODE = "SESSION_TOKEN_COST_LIMIT_REACHED";

interface SessionLimitPolicyInput {
  readonly config: ToolLoopHarnessConfig;
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly emissionState: HarnessEmissionState;
  readonly session: HarnessSession;
}

/**
 * Pre-model-call gate for the session token budget.
 *
 * Returns `null` when the session is within budget. Over budget, sessions
 * that can request input park on the deterministic continuation prompt;
 * others fail fast with `SESSION_TOKEN_LIMIT_REACHED`.
 */
export async function enforceSessionUsageLimit(
  input: SessionLimitPolicyInput & { readonly messages: readonly HarnessModelMessage[] },
): Promise<StepResult | null> {
  const violation = getSessionUsageLimitViolation(input.session);
  if (violation === null) {
    return null;
  }

  const { emit } = input;
  // A zero limit is an exhausted quota inherited by a delegated task.
  // Approving would bump the runtime limit by the configured limit -- zero --
  // so fail the child and let its parent reach the resumable limit gate.
  if (
    violationWindow(violation) > 0 &&
    emit !== undefined &&
    input.config.capabilities?.requestInput === true
  ) {
    return await holdOnSessionUsageLimit({ ...input, emit, violation });
  }

  return failSessionUsageLimit({ ...input, violation });
}

/**
 * Holds the turn on its budget question. The question is asked once; a later
 * step that still has no answer holds again without asking. The held history
 * keeps the step's messages, so a message sent meanwhile is read after Continue.
 */
async function holdOnSessionUsageLimit(input: {
  readonly emit: NonNullable<ToolLoopHarnessConfig["handleEvent"]>;
  readonly emissionState: HarnessEmissionState;
  readonly messages: readonly HarnessModelMessage[];
  readonly session: HarnessSession;
  readonly violation: SessionUsageLimitViolation;
}): Promise<StepResult> {
  const request = createSessionLimitContinuationRequest({
    sessionId: input.session.sessionId,
    violation: input.violation,
  });
  let session: HarnessSession = { ...input.session, history: [...input.messages] };
  let { emissionState } = input;
  if (readSessionLimitRequest(session)?.request.requestId !== request.requestId) {
    session = openSessionLimitRequest(session, sessionLimitRequestAt(request, emissionState));
    await input.emit(
      createInputRequestedEvent({
        requests: [request],
        sequence: emissionState.sequence,
        stepIndex: emissionState.stepIndex,
        turnId: emissionState.turnId,
      }),
    );
  }
  emissionState = advanceStep(emissionState);
  await input.emit(
    createTurnWaitingEvent({
      on: "input",
      sequence: emissionState.sequence,
      turnId: emissionState.turnId,
      usage: getSessionUsage(session),
    }),
  );
  return {
    held: { kind: "request" },
    next: null,
    session: setHarnessEmissionState(session, emissionState),
  };
}

function violationWindow(violation: SessionUsageLimitViolation): number {
  return violation.kind === "token-cost" ? violation.limitUsd : violation.limit;
}

function formatSessionLimitMessage(kind: SessionUsageLimitViolation["kind"]): string {
  return kind === "token-cost"
    ? "The session reached its configured model token-cost limit."
    : `The session reached its configured ${kind} token limit.`;
}

async function failSessionUsageLimit(input: {
  readonly config: ToolLoopHarnessConfig;
  readonly emit?: ToolLoopHarnessConfig["handleEvent"];
  readonly emissionState: HarnessEmissionState;
  readonly session: HarnessSession;
  readonly violation: SessionUsageLimitViolation;
}): Promise<StepResult> {
  const usage = getSessionTokenUsage(input.session);
  const message = formatSessionLimitMessage(input.violation.kind);
  const details: import("#shared/json.js").JsonObject =
    input.violation.kind === "token-cost"
      ? {
          costUsd: usage.costUsd,
          kind: input.violation.kind,
          limitUsd: input.violation.limitUsd,
          usedCostUsd: input.violation.usedCostUsd,
        }
      : {
          inputTokens: usage.inputTokens,
          kind: input.violation.kind,
          limit: input.violation.limit,
          outputTokens: usage.outputTokens,
          usedTokens: input.violation.usedTokens,
        };

  if (input.emit) {
    await emitFailedStep(input.emit, input.emissionState, {
      code:
        input.violation.kind === "token-cost"
          ? SESSION_TOKEN_COST_LIMIT_REACHED_CODE
          : SESSION_TOKEN_LIMIT_REACHED_CODE,
      details,
      message,
      sessionId: input.session.sessionId,
      usage: getSessionUsage(input.session),
    });
  }

  return {
    next: { done: true, output: "" },
    session: input.session,
  };
}
