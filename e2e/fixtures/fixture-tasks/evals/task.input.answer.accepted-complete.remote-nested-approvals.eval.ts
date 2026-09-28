import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireTaskView,
  waitForCompletedTask,
  waitForTaskInputs,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

export default defineTaskEval({
  transition: {
    primary: "task.input.answer.accepted-complete",
    dimensions: { transport: "remote" },
  },
  description:
    "Alice approves two independent nested children of a remote background agent through the parent session.",
  timeoutMs: 120_000,
  async test(t) {
    const started = await t.send("TASK-NESTED-REMOTE-APPROVALS", {
      taskDeliveryPolicy: "cohort",
    });
    started.expectOk();
    started.messageIncludes("TASK-NESTED-REMOTE-STARTED");
    const taskId = requireBackgroundTaskId(started);

    const { requests, session } = await waitForTaskInputs(t, started.session, "first_gate", 2);
    if (new Set(requests.map((request) => request.requestId)).size !== 2) {
      throw new Error("Nested approvals share a request ID.");
    }
    const firstAnswers = await session.respond(
      requests.map((request) => ({ requestId: request.requestId, optionId: "approve" })),
    );
    firstAnswers.expectOk();
    firstAnswers.noFailedActions();

    // Each child has a second gate after the first one, so completing both
    // also proves that each first answer returned to its own nested child.
    const { requests: second, session: secondSession } = await waitForTaskInputs(
      t,
      firstAnswers.session,
      "second_gate",
      2,
    );
    const answered = await secondSession.respond(
      second.map((request) => ({ requestId: request.requestId, optionId: "approve" })),
    );
    answered.expectOk();
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
            "TASK-NESTED-APPROVALS-COMPLETE",
        "both nested approvals resume the remote task",
      ),
    );
    t.noFailedActions();
  },
});
