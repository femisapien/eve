import { afterEach } from "vitest";

import { takeSessionContractViolations } from "#execution/session-contract-monitor.js";

// Every session a test runs from its start is checked against the stream
// contract; see `protocol/session-contract.ts`.
process.env.EVE_SESSION_CONTRACT = "record";

afterEach(() => {
  const violations = takeSessionContractViolations();
  if (violations.length === 0) return;
  throw new Error(
    `The session stream broke its contract:\n${violations
      .map((violation) => `  [${violation.rule}] ${violation.sessionId}: ${violation.message}`)
      .join("\n")}`,
  );
});
