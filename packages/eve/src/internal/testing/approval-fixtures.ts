import type { ModelMessage } from "ai";

import { validateHarnessModelMessages } from "#harness/messages.js";
import {
  appendPendingInputBatch,
  type PendingInputBatchEvent,
} from "#harness/pending-input-batches.js";
import type { HarnessSession } from "#harness/types.js";
import type { InputRequest } from "#shared/input.js";

const DEFAULT_EVENT: PendingInputBatchEvent = { sequence: 0, stepIndex: 0, turnId: "turn_0" };

/**
 * Builds the state a held turn has after a model step raised tool approvals:
 * the step's response at the tail of history, and one turn entry per request.
 */
export function parkApprovals(input: {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseAuthRequiredRequestIds?: readonly string[];
  /** The model step's response, which holds the waiting calls. */
  readonly responseMessages?: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  return appendPendingInputBatch({
    event: input.event ?? DEFAULT_EVENT,
    requests: input.requests,
    responseAuthRequiredRequestIds: input.responseAuthRequiredRequestIds,
    session: {
      ...input.session,
      history: validateHarnessModelMessages([
        ...input.session.history,
        ...(input.responseMessages ?? []),
      ]),
    },
  });
}
