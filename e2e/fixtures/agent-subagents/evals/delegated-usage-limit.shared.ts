import type { EveEvalContext } from "eve/evals";

import { SURVEY_WORKER_INPUT_TOKENS } from "../constants";

/**
 * A delegated agent's spend counts against the session that delegated to it.
 * Alice asks for a tide survey, and the parent hands it to survey-worker. The
 * worker's one model call reports more input tokens than the parent's default
 * session budget, so the parent's next model call fails with its own
 * session-limit error, whose used figure includes the worker's tokens.
 * Returns the session for checks on how the parent delegated.
 */
export async function expectSurveyCountedAgainstParent(t: EveEvalContext, message: string) {
  const turn = await t.send(message);
  turn.notEvent("input.requested");
  turn.event("step.failed", {
    count: 1,
    data: {
      code: "SESSION_TOKEN_LIMIT_REACHED",
      details: {
        kind: "input",
        usedTokens: (used: unknown) =>
          typeof used === "number" && used >= SURVEY_WORKER_INPUT_TOKENS,
      },
    },
  });
  return turn.session;
}
