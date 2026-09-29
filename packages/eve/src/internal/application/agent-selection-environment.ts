import { resolve } from "node:path";

import type { AgentEntrySelection } from "#compiler/entry-sources.js";
import { assertValidPublicAgentName } from "#internal/agent-name.js";

/**
 * Internal envelope that selects one `createAgent` entry module instead of
 * filesystem discovery. Host integrations set it; the CLI reads it once.
 */
export const EVE_INTERNAL_AGENT_SELECTION_ENV = "EVE_INTERNAL_AGENT_SELECTION";

const EXAMPLE = '{"entry":"agent.ts","registration":"my-agent"}';

/**
 * Parses the selection envelope. The entry path is resolved against `appRoot`
 * (the process cwd), never against a discovered project root.
 */
export function readAgentEntrySelectionEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  appRoot: string,
): AgentEntrySelection | undefined {
  const raw = environment[EVE_INTERNAL_AGENT_SELECTION_ENV];
  if (raw === undefined || raw === "") return undefined;
  const invalid = (detail: string) =>
    new Error(
      `${EVE_INTERNAL_AGENT_SELECTION_ENV} ${detail}. Set it to JSON like ${EXAMPLE}, or unset it to use filesystem discovery.`,
    );
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid("is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("must be a JSON object");
  }
  const { entry, registration, ...rest } = value as Record<string, unknown>;
  const unknownKeys = Object.keys(rest);
  if (unknownKeys.length > 0) {
    throw invalid(
      `has unsupported keys ${unknownKeys.map((key) => JSON.stringify(key)).join(", ")}`,
    );
  }
  if (typeof entry !== "string" || entry.trim() === "") {
    throw invalid('requires a non-empty "entry" module path');
  }
  if (typeof registration !== "string") {
    throw invalid('requires a "registration" name');
  }
  assertValidPublicAgentName(registration, `${EVE_INTERNAL_AGENT_SELECTION_ENV} registration`);
  return { appRoot: resolve(appRoot), entry, registration };
}
