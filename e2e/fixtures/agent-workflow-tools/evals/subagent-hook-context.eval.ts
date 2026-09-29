import { defineEval } from "eve/evals";
import type { SubagentHookObservation } from "../subagent-hook-audit";

// An agent tool call is a task: task.started, agent.started, and task.settled
// carry its callId. agent.started can arrive while a model step runs; its
// hooks' state must still reach the next turn.
export default defineEval({
  description:
    "Delegation and later wildcard hooks continue after a typed hook writes parent state and throws.",
  async test(t) {
    const initial = await t.send(
      "Alice asks Bob to review a short report and return his result. SUBAGENT-HOOKS:direct",
    );
    initial.expectOk();
    initial.calledTool("load_skill", { count: 1, status: "completed" });
    initial.messageIncludes("Alice's hook audit");

    const audit = await initial.session.send(
      "Alice reviews the recorded hook observations for Bob's completed report. SUBAGENT-HOOKS:AUDIT",
    );
    audit.expectOk();
    audit.calledTool("load_skill", { count: 1, status: "completed" });
    t.eventsSatisfy("the parent's dynamic skill remains loadable after delegation", () =>
      [initial, audit].every((turn) =>
        String(turn.toolCalls.find((call) => call.name === "load_skill")?.output).includes(
          "DELEGATION-POLICY:",
        ),
      ),
    );
    audit.calledTool("read_subagent_hooks", { count: 1, status: "completed" });
    const observations = audit.toolCalls.find(
      (call) => call.name === "read_subagent_hooks",
    )?.output;
    t.eventsSatisfy(
      "both hook subscriptions receive the child's start and exact result once",
      (events) => {
        if (!Array.isArray(observations) || observations.length !== 6) return false;
        const completion = events.find((event) => event.type === "task.settled");
        if (completion?.type !== "task.settled") return false;
        const output = completion.data.output;
        if (typeof output !== "string" || !output.startsWith("WORKFLOW-CHILD:")) return false;
        if (!initial.message?.includes(output)) return false;
        const records = observations as SubagentHookObservation[];
        const once = (
          subscriber: SubagentHookObservation["subscriber"],
          type: SubagentHookObservation["type"],
          output?: string,
        ) =>
          records.filter(
            (record) =>
              record.subscriber === subscriber &&
              record.type === type &&
              (output === undefined || record.output === output),
          ).length === 1;
        return (
          records.every(
            (record) =>
              record.sessionId === initial.sessionId && record.callId === completion.data.callId,
          ) &&
          (["typed", "wildcard"] as const).every(
            (subscriber) =>
              once(subscriber, "agent.started") &&
              once(subscriber, "task.started") &&
              once(subscriber, "task.settled", output),
          )
        );
      },
    );
    t.eventsSatisfy(
      "hooks receive the exact published event IDs",
      (events) =>
        Array.isArray(observations) &&
        observations.every((record: SubagentHookObservation) =>
          events.some((event) => event.meta.id === record.eventId && event.type === record.type),
        ),
    );
    t.eventsSatisfy(
      "hooks persist parent sandbox files for the next turn",
      () =>
        Array.isArray(observations) &&
        observations.every(
          (record: SubagentHookObservation & { sandboxCallId: string | null }) =>
            record.sandboxCallId === record.callId,
        ),
    );
    t.event("agent.started", { data: { name: "workflow-marker" }, count: 1 });
    t.event("task.started", { data: { name: "workflow-marker" }, count: 1 });
    t.event("task.settled", { data: { status: "completed" }, count: 1 });
    t.notEvent("session.failed");
    t.notEvent("turn.failed");
    t.noFailedActions();
    t.succeeded();
  },
});
