import { defineEval } from "eve/evals";
import {
  DYNAMIC_PACKAGE_FILE_TOKEN,
  DYNAMIC_PACKAGE_MARKDOWN_TOKEN,
  DYNAMIC_PACKAGE_NAME,
  DYNAMIC_PACKAGE_REQUESTS,
} from "../../agent/lib/dynamic-skill-package";

export default defineEval({
  description:
    "Dynamic skill packages survive durable tool steps and materialize for skill handles and filesystem tools.",
  async test(t) {
    for (const [mode, prompt] of Object.entries(DYNAMIC_PACKAGE_REQUESTS)) {
      const turn = await t.send(prompt);
      turn.expectOk();
      turn.loadedSkill(DYNAMIC_PACKAGE_NAME, {
        output: new RegExp(DYNAMIC_PACKAGE_MARKDOWN_TOKEN),
      });
      turn.calledTool(mode === "handle" ? "read_skill_reference" : "read_file", {
        output: new RegExp(DYNAMIC_PACKAGE_FILE_TOKEN),
      });
      turn.messageIncludes(DYNAMIC_PACKAGE_FILE_TOKEN);
    }
  },
});
