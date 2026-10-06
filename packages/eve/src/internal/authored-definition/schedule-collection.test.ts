import { describe, expect, it } from "vitest";
import { z } from "#compiled/zod/index.js";
import { normalizeScheduleCollectionDefinition } from "#internal/authored-definition/schedule-collection.js";
import { defineScheduleSubscription } from "#public/schedules/subscription.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";

const valid = {
  provider: inMemoryScheduleProvider(),
  schema: z.object({ task: z.string() }),
  auth: () => null,
  run: async () => {},
};

describe("normalizeScheduleCollectionDefinition", () => {
  it.each([
    ["no auth", { auth: undefined }, '"auth" is required'],
    ["no schema", { schema: undefined }, '"schema" is required'],
    ["a malformed schema", { schema: { "~standard": {} } }, "validate function"],
    ["no run", { run: undefined }, '"run" is required'],
    ["a malformed prepare hook", { prepare: true }, '"prepare" must be a function'],
    [
      "approval for the removed update tool",
      { tools: { approval: { update: () => "user-approval" } } },
      "update",
    ],
    ["the removed capture hook", { resolvePayload: () => ({}) }, "resolvePayload"],
    ["the removed deliveries", { deliveries: {} }, "deliveries"],
  ])("rejects a subscription with %s", (_label, override, message) => {
    const definition = defineScheduleSubscription({ ...valid, ...override } as never);
    expect(() => normalizeScheduleCollectionDefinition(definition, "Invalid.")).toThrow(message);
  });

  it("accepts a schema and callback without configured deliveries", () => {
    expect(() =>
      normalizeScheduleCollectionDefinition(defineScheduleSubscription(valid), "Invalid."),
    ).not.toThrow();
  });
});
