import { defineHook } from "eve/hooks";
import { recordSubagentHook } from "../../subagent-hook-audit";

export default defineHook({
  events: {
    "agent.started": (event, ctx) => recordSubagentHook("typed", event, ctx),
    "task.started": (event, ctx) => recordSubagentHook("typed", event, ctx),
    "task.settled": (event, ctx) => recordSubagentHook("typed", event, ctx),
    "*": (event, ctx) => recordSubagentHook("wildcard", event, ctx),
  },
});
