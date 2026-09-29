import { describe, expect, it } from "vitest";

import {
  EVE_INTERNAL_AGENT_SELECTION_ENV,
  readAgentEntrySelectionEnvironment,
} from "./agent-selection-environment.js";

const read = (value: string | undefined) =>
  readAgentEntrySelectionEnvironment({ [EVE_INTERNAL_AGENT_SELECTION_ENV]: value }, "/app");

describe("readAgentEntrySelectionEnvironment", () => {
  it("selects filesystem discovery when unset and resolves entries against the cwd", () => {
    expect(read(undefined)).toBeUndefined();
    expect(read('{"entry":"src/agent.ts","registration":"support"}')).toEqual({
      appRoot: "/app",
      entry: "src/agent.ts",
      registration: "support",
    });
  });

  it.each([
    ["not json", "is not valid JSON"],
    ["[]", "must be a JSON object"],
    ['{"entry":"a.ts","registration":"x","root":"."}', 'unsupported keys "root"'],
    ['{"registration":"x"}', 'non-empty "entry"'],
    ['{"entry":"a.ts"}', 'requires a "registration"'],
    ['{"entry":"a.ts","registration":"Bad Name"}', "registration"],
  ])("rejects %s with an actionable message", (value, message) => {
    expect(() => read(value)).toThrow(message);
  });
});
