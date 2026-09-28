import { equals, satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireTaskView,
  waitForCompletedTask,
  waitForTaskAuthorization,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";
import { AUTHORIZATION_CODE, AUTHORIZATION_NAME } from "../agent/lib/authorization-fixture.js";

/** A task-owned interactive authorization keeps its distinct lifecycle and task blocker. */
export default defineTaskEval({
  description:
    "A background child surfaces interactive authorization, resumes through its webhook, and completes without masquerading as ordinary input.",
  transition: {
    primary: "task.authorization.callback.accepted-current-attempt",
    dimensions: { transport: "local" },
  },
  async test(t) {
    const started = await t.send("TASK-C7-AUTHORIZATION", { taskDeliveryPolicy: "cohort" });
    started.expectOk();
    started.messageIncludes("TASK-C7-STARTED");
    started.event("action.result", {
      count: 1,
      data: {
        result: { kind: "tool-result", output: { status: "working" }, toolName: "approval-worker" },
      },
    });
    const taskId = requireBackgroundTaskId(started);

    const required = await waitForTaskAuthorization(
      t,
      started.session,
      started,
      "authorization.required",
    );
    required.turn.event("authorization.required", {
      count: 1,
      data: { authorization: { userCode: AUTHORIZATION_CODE }, name: AUTHORIZATION_NAME },
    });
    required.turn.notEvent("input.requested");

    const webhookUrl = required.event.data.webhookUrl;
    if (webhookUrl === undefined) throw new Error("C7 authorization.required had no webhook URL.");
    const callback = new URL(webhookUrl);
    callback.searchParams.set("code", AUTHORIZATION_CODE);
    const callbackResponse = await fetch(callback, {
      method: "GET",
    });
    await t.require(callbackResponse.status, equals(200));

    const completed = await waitForTaskAuthorization(
      t,
      required.session,
      undefined,
      "authorization.completed",
    );
    completed.turn.event("authorization.completed", {
      count: 1,
      data: { name: AUTHORIZATION_NAME, outcome: "authorized" },
    });

    const terminal = await waitForCompletedTask(
      t,
      completed.session,
      "TASK-C7-AUTHORIZATION-VERIFY",
      taskId,
    );
    const terminalView = requireTaskView(terminal.requireToolCall("task_cancel").output, taskId);
    await t.require(
      terminalView,
      satisfies(
        (view: Record<string, unknown>) =>
          Reflect.get(view, "status") === "completed" &&
          Reflect.get(Reflect.get(view, "lastOutput") ?? {}, "type") === "result" &&
          Reflect.get(Reflect.get(view, "lastOutput") ?? {}, "data") ===
            "C7-AUTHORIZATION-COMPLETE",
        "authorized child reaches its deterministic terminal output",
      ),
    );
    t.event("authorization.required", {
      count: 1,
      data: { authorization: { userCode: AUTHORIZATION_CODE }, name: AUTHORIZATION_NAME },
    });
    t.event("authorization.completed", {
      count: 1,
      data: { name: AUTHORIZATION_NAME, outcome: "authorized" },
    });
    t.eventOrder([{ type: "authorization.required" }, { type: "authorization.completed" }]);
    t.notEvent("input.requested");
    t.noFailedActions();
  },
});
