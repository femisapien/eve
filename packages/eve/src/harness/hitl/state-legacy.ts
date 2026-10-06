/**
 * Reading human input's state, upgrading what earlier releases stored: grants
 * under the old approved-tools key, a batch parked under the old coordination
 * key, and responders' authorizations that were requests of their own. Kept
 * apart from `state.ts` because upgrading uses the rules, and the state's
 * shapes must not depend on them.
 */
import type { ModelMessage } from "ai";

import type { SessionStateMap, StepInput } from "#harness/types.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";

import { adoptCandidateAuthorizations } from "./approval-candidate.js";
import { withMessages } from "./held-step.js";
import type { RequestAt } from "./input.js";
import {
  LEGACY_BATCH_KEY,
  LEGACY_GRANTS_KEY,
  parseState,
  STATE_KEY,
  type HeldStep,
  type HumanInputState,
} from "./state.js";

/**
 * The session's human input. A session parked on runtime calls before the
 * held step held them has them under the old coordination key, with its
 * response there: they become the held step, which its approvals' step
 * already was when it had any.
 */
export function readState(sessionState: SessionStateMap | undefined): HumanInputState {
  const state = withLegacyGrants(
    // Responders' authorizations were once requests of their own.
    adoptCandidateAuthorizations(parseState(sessionState?.[STATE_KEY])),
    sessionState?.[LEGACY_GRANTS_KEY],
  );
  const legacy = parseLegacyBatch(sessionState?.[LEGACY_BATCH_KEY]);
  if (legacy === undefined) return state;
  const { held } = state;
  const step: HeldStep = {
    at: held?.at ?? legacy.event,
    messages: withMessages(legacy.responseMessages, held?.messages ?? []),
    runtime: { tasks: [...(held?.runtime?.tasks ?? []), ...legacy.tasks] },
    ...(legacy.followingInput !== undefined && { following: legacy.followingInput }),
  };
  return { ...state, held: step };
}

/** Grants a session stored before `HumanInput` stay granted. */
function withLegacyGrants(state: HumanInputState, value: unknown): HumanInputState {
  if (!Array.isArray(value)) return state;
  const legacy = value.filter((key): key is string => typeof key === "string");
  const grants = [...new Set([...state.grants, ...legacy])];
  return grants.length === state.grants.length ? state : { ...state, grants };
}

interface LegacyBatch {
  readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  readonly event: RequestAt;
  readonly responseMessages: readonly ModelMessage[];
  readonly followingInput?: StepInput;
}

function parseLegacyBatch(value: unknown): LegacyBatch | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const batch = value as LegacyBatch;
  if (
    !Array.isArray(batch.tasks) ||
    !Array.isArray(batch.responseMessages) ||
    typeof batch.event !== "object" ||
    batch.event === null
  ) {
    return undefined;
  }
  return batch;
}
