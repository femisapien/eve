import { defineEval } from "eve/evals";

import { runStepAuth } from "./step-auth.shared.ts";

export default defineEval({
  description: "A rejected token triggers sign-in through ctx.requireAuth, then the step succeeds.",
  timeoutMs: 90_000,

  async test(t) {
    await runStepAuth(t, "EXPLICIT");
  },
});
