import type { RouteHandlerArgs } from "#channel/routes.js";

/** `describe` and `readSkill` for tests whose routes never read the agent description. */
export function mockAgentDescriptionRouteArgs(): Pick<RouteHandlerArgs, "describe" | "readSkill"> {
  const unavailable = async (): Promise<never> => {
    throw new Error("Agent description is unavailable in this test.");
  };
  return { describe: unavailable, readSkill: unavailable };
}
