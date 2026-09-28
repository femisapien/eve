import { equals, satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireTaskView,
  waitForCompletedTask,
  waitForTaskAuthorization,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";
import { AUTHORIZATION_CODE, AUTHORIZATION_NAME } from "../agent/lib/authorization-fixture.js";

export default defineTaskEval({
  transition: {
    primary: "task.authorization.callback.accepted-current-attempt",
    dimensions: { transport: "remote" },
  },
  description:
    "Alice completes a nested child's authorization request from a remote background agent on the parent session.",
  timeoutMs: 120_000,
  async test(t) {
    const started = await t.send("TASK-NESTED-REMOTE-AUTHORIZATION", {
      taskDeliveryPolicy: "cohort",
    });
    started.expectOk();
    const taskId = requireBackgroundTaskId(started);
    const required = await waitForTaskAuthorization(
      t,
      started.session,
      started,
      "authorization.required",
    );
    required.turn.event("authorization.required", {
      data: { name: AUTHORIZATION_NAME, authorization: { userCode: AUTHORIZATION_CODE } },
    });
    const webhookUrl = required.event.data.webhookUrl;
    if (webhookUrl === undefined) throw new Error("Nested authorization has no webhook URL.");
    const callback = new URL(webhookUrl);
    callback.searchParams.set("code", AUTHORIZATION_CODE);
    await t.require((await fetch(callback)).status, equals(200));

    const completed = await waitForTaskAuthorization(
      t,
      required.session,
      undefined,
      "authorization.completed",
    );
    completed.turn.event("authorization.completed", {
      data: { name: AUTHORIZATION_NAME, outcome: "authorized" },
    });
    const terminal = await waitForCompletedTask(
      t,
      completed.session,
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
            "TASK-NESTED-AUTHORIZATION-COMPLETE",
        "authorized nested child completes its remote task",
      ),
    );
    t.noFailedActions();
  },
});
