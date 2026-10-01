/**
 * Session token and token-cost limit policy for the tool-loop harness.
 *
 * {@link enforceSessionUsageLimit} runs before each model call and fails the
 * turn once the session is over budget. Asking a person to continue returns
 * as a turn-owned request.
 */
import { emitFailedStep, type HarnessEmissionState } from "#harness/emission.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import {
  getSessionUsageLimitViolation,
  getSessionTokenUsage,
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
 * Pre-model-call gate for the session token budget. Returns `null` when the
 * session is within budget, and fails the turn with
 * `SESSION_TOKEN_LIMIT_REACHED` (or the cost variant) otherwise.
 */
export async function enforceSessionUsageLimit(
  input: SessionLimitPolicyInput & { readonly messages: readonly HarnessModelMessage[] },
): Promise<StepResult | null> {
  const violation = getSessionUsageLimitViolation(input.session);
  if (violation === null) {
    return null;
  }
  return failSessionUsageLimit({ ...input, violation });
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
    });
  }

  return {
    next: { done: true, output: "" },
    session: input.session,
  };
}
