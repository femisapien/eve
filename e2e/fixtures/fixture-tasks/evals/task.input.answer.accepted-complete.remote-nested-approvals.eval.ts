import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireSessionStreamIndex,
  requireTaskView,
  waitForCompletedTask,
  type TaskEvalSessionDriver,
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

    let session: TaskEvalSessionDriver = started.session;
    for (let attempt = 0; attempt < 8 && session.pendingInputRequests.length < 2; attempt += 1) {
      if (session.sessionId === undefined) throw new Error("Parent session has no id.");
      const live = t.target.watchTurn(session.sessionId, {
        startIndex: requireSessionStreamIndex(session, "nested approval wait"),
      });
      (await live.result()).noFailedActions();
      session = live.session;
    }
    const requests = session.pendingInputRequests;
    if (
      requests.length !== 2 ||
      requests.some((request) => request.action.toolName !== "first_gate")
    ) {
      throw new Error(
        `Expected two independent first_gate approvals; got ${requests.map((request) => request.action.toolName).join(", ")}.`,
      );
    }
    if (new Set(requests.map((request) => request.requestId)).size !== 2) {
      throw new Error("Nested approvals share a request ID.");
    }
    const firstAnswers = await session.respond(
      requests.map((request) => ({ requestId: request.requestId, optionId: "approve" })),
    );
    firstAnswers.expectOk();
    firstAnswers.noFailedActions();
    session = firstAnswers.session;

    // Each child has a second gate after the first one, so completing both
    // also proves that each first answer returned to its own nested child.
    for (let attempt = 0; attempt < 8 && session.pendingInputRequests.length < 2; attempt += 1) {
      if (session.sessionId === undefined) throw new Error("Parent session has no id.");
      const live = t.target.watchTurn(session.sessionId, {
        startIndex: requireSessionStreamIndex(session, "nested second approval wait"),
      });
      (await live.result()).noFailedActions();
      session = live.session;
    }
    const second = session.pendingInputRequests;
    if (
      second.length !== 2 ||
      second.some((request) => request.action.toolName !== "second_gate")
    ) {
      throw new Error("Both nested children did not reach their second approval gate.");
    }
    const answered = await session.respond(
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
