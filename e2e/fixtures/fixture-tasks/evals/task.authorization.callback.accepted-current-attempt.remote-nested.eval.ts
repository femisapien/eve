import type { EveEvalContext, EveEvalTurn } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  requireSessionStreamIndex,
  requireTaskView,
  type TaskEvalSessionDriver,
  waitForCompletedTask,
} from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

const AUTHORIZATION_CODE = "c7-deterministic-code";
const AUTHORIZATION_NAME = "c7-task-authorization";

type AuthorizationEvent = Extract<
  EveEvalTurn["events"][number],
  { readonly type: "authorization.completed" | "authorization.required" }
>;

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
    const required = await waitForAuthorization(
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

    const completed = await waitForAuthorization(
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

async function waitForAuthorization<T extends AuthorizationEvent["type"]>(
  t: EveEvalContext,
  initialSession: TaskEvalSessionDriver,
  initialTurn: EveEvalTurn | undefined,
  type: T,
): Promise<{
  event: Extract<AuthorizationEvent, { readonly type: T }>;
  session: TaskEvalSessionDriver;
  turn: EveEvalTurn;
}> {
  let session = initialSession;
  let turn = initialTurn;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const event = turn?.events.find(
      (candidate): candidate is Extract<AuthorizationEvent, { readonly type: T }> =>
        candidate.type === type,
    );
    if (event !== undefined) return { event, session, turn: turn! };
    if (session.sessionId === undefined) throw new Error("Parent session has no id.");
    const live = t.target.watchTurn(session.sessionId, {
      startIndex: requireSessionStreamIndex(session, `${type} wait`),
    });
    turn = await live.result();
    turn.noFailedActions();
    session = live.session;
  }
  throw new Error(`Nested remote child did not surface ${type}.`);
}
