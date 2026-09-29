import { defineMemory } from "eve/memory";

export default defineMemory({
  description: "Empty recall used to verify approval-resume message ordering.",
  provider: {
    recall: {
      "turn.started": async () => ({ messages: [] }),
    },
  },
  scope: "approval-resume-e2e",
});
