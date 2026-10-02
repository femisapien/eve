import type { ModelMessage } from "ai";

import { approvalStep, type InputRequestEvent } from "#harness/open-approvals.js";
import { suspendStep } from "#harness/turn-state.js";
import type { HarnessSession } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

const DEFAULT_EVENT: InputRequestEvent = { sequence: 0, stepIndex: 0, turnId: "turn_0" };

/**
 * Builds the state a held turn has after a model step raised tool approvals:
 * the step's response withheld in a suspended step with its requests.
 */
export function parkApprovals(input: {
  readonly event?: InputRequestEvent;
  readonly requests: readonly InputRequest[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  /** The model step's response, which holds the waiting calls. */
  readonly responseMessages?: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  return suspendStep(
    input.session,
    approvalStep({
      event: input.event ?? DEFAULT_EVENT,
      messages: input.responseMessages ?? [],
      requests: input.requests,
      responseAuthRequiredRequestIds: input.responseAuthRequiredRequestIds,
      tasks: [],
    }),
  );
}
