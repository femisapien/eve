import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "A model lists stubbed tasks, completes the intended task, and reports the remaining tasks in a follow-up turn.",
  async test(t) {
    const session = await t.session({
      stubs: [
        {
          id: "tasks",
          tool: "list_tasks",
          responses: [
            {
              tasks: [
                { id: "milk", title: "Buy milk" },
                { id: "dog", title: "Walk dog" },
                { id: "rent", title: "Pay rent" },
              ],
            },
            {
              tasks: [
                { id: "dog", title: "Walk dog" },
                { id: "rent", title: "Pay rent" },
              ],
            },
          ],
        },
        {
          id: "complete-milk",
          tool: "complete_task",
          match: { task_id: { const: "milk" } },
          response: { success: true },
        },
      ],
    });

    const first = await session.send("Alice asks: what open tasks do I have?");
    first.expectOk();
    first.calledTool("list_tasks", { count: 1 });
    first.notCalledTool("complete_task");
    first.messageIncludes("Buy milk");
    first.messageIncludes("Walk dog");
    first.messageIncludes("Pay rent");

    const second = await session.send(
      "Please complete Buy milk, then list only the tasks that are still open.",
    );
    second.expectOk();
    second.calledTool("complete_task", {
      input: { task_id: "milk" },
      output: { success: true },
      count: 1,
    });
    second.calledTool("list_tasks", { count: 1 });
    second.toolOrder(["complete_task", "list_tasks"]);
    second.messageIncludes("Walk dog");
    second.messageIncludes("Pay rent");
    t.check(
      second.message,
      satisfies(
        (value) => typeof value === "string" && !value.includes("Buy milk"),
        "only remaining tasks are listed",
      ),
    );
    t.noFailedActions();
  },
});
