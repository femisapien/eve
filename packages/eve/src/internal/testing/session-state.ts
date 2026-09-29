import {
  DURABLE_SESSION_VERSION,
  type DurableSessionState,
} from "#execution/durable-session-store.js";

/** Complete session checkpoint for tests that exercise workflow coordination. */
export function createTestSessionState(
  overrides: Partial<DurableSessionState> = {},
): DurableSessionState {
  return {
    continuationToken: overrides.continuationToken ?? "test-token",
    sessionId: overrides.sessionId ?? "test-session",
    turn: { open: false, sequence: 0, stepIndex: 0, turnId: "turn_0" },
    hasProxyInputRequests: false,
    version: DURABLE_SESSION_VERSION,
    snapshot: {
      session: {
        agent: { system: "" },
        continuationToken: overrides.continuationToken ?? "test-token",
        history: [],
        sessionId: overrides.sessionId ?? "test-session",
      },
    },
    ...overrides,
  };
}
