import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireTaskView,
  waitForCompletedTask,
  waitForTaskInput,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

export default defineTaskEval({
  description:
    "Alice answers a remote workflow tool's ctx.ask question through the parent after the background task starts.",
  transition: {
    primary: "task.input.answer.accepted-complete",
    dimensions: { transport: "remote" },
  },
  async test(t) {
    const started = await t.send("TASK-REMOTE-WORKFLOW-QUESTION", {
      taskDeliveryPolicy: "cohort",
    });
    started.expectOk();
    started.messageIncludes("TASK-NESTED-REMOTE-STARTED");
    const taskId = requireBackgroundTaskId(started);

    const pending = await waitForTaskInput(t, started.session, "remote_question");
    if (
      pending.request.kind !== "question" ||
      pending.request.prompt !== "What is Alice's approval word?"
    ) {
      throw new Error("Remote ctx.ask did not surface its question on the parent.");
    }
    const answered = await pending.session.respond([
      { requestId: pending.request.requestId, text: "alice-ok" },
    ]);
    answered.expectOk();
    answered.noFailedActions();

    const terminal = await waitForCompletedTask(
      t,
      answered.session,
      "TASK-NESTED-REMOTE-VERIFY",
      taskId,
    );
    const view = requireTaskView(terminal.requireToolCall("task_cancel").output, taskId);
    await t.require(
      view,
      satisfies(
        (task: Record<string, unknown>) =>
          Reflect.get(task, "status") === "completed" &&
          Reflect.get(Reflect.get(task, "lastOutput") ?? {}, "data") ===
            "TASK-REMOTE-QUESTION-COMPLETE",
        "answer to remote ctx.ask resumes the remote task",
      ),
    );
    t.noFailedActions();
  },
});
