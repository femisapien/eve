import type { SessionStateMap } from "#harness/types.js";

// What a person approved in this session, by approval key, so `once()` asks
// for each key only the first time.
const APPROVED_TOOLS_KEY = "eve.runtime.hitl.approvedTools";

export function readApprovedTools(state: SessionStateMap | undefined): ReadonlySet<string> {
  const value = state?.[APPROVED_TOOLS_KEY];
  return Array.isArray(value)
    ? new Set(value.filter((key): key is string => typeof key === "string"))
    : new Set();
}

export function recordApprovedTools(
  state: SessionStateMap | undefined,
  keys: readonly string[],
): SessionStateMap | undefined {
  if (keys.length === 0) return state;
  return { ...state, [APPROVED_TOOLS_KEY]: [...new Set([...readApprovedTools(state), ...keys])] };
}
