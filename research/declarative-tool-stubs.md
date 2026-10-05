---
issue: https://linear.app/vercel/issue/AX-5133
status: implementing
last_updated: "2026-10-05"
---

# Declarative tool stubs

Evals need predictable tool results against local and deployed agents, while checking both requested actions and user-facing responses. Provide JSON constants and sequences at session creation; keep existing tool, order, and response assertions separate.

```ts
const session = await t.session({
  stubs: [
    { id: "tasks", tool: "list_tasks", responses: [["milk", "dog"], ["dog"]] },
    {
      id: "complete",
      tool: "complete_task",
      match: { task_id: { const: "milk" } },
      response: { success: true },
    },
  ],
});
await session.send("List my tasks.");
const completed = await session.send("Complete milk, then list what remains.");
completed.calledTool("complete_task", { input: { task_id: "milk" }, count: 1 });
completed.toolOrder(["complete_task", "list_tasks"]);
```

## Contract

- Fixed configuration for a root session and its local descendants. New roots are isolated; configuration is never forwarded to remote agents.
- A named input field must exist and satisfy its reference-free JSON Schema constraint. Extra top-level fields are allowed. Reject invalid or unsupported schemas during setup; matching does not coerce or mutate input.
- No match runs the real tool. Multiple matches fail. A selected stub failure never invokes the real executor and fails the eval even if the model recovers.
- Each rule advances per logical matching call, including several calls within a turn. Replays and retries reuse the recorded result; exhaustion repeats the last response. Unused stubs are allowed.
- Ordinary, dynamic, workflow, and qualified connection operations retain validation, approval, output processing, and event envelopes. Persistent tools require unconditional replacement. Provider-hosted tools are outside scope.
- Connection discovery and authentication stay live; stubs replace only execution of a known operation.

## Durable playback

The original root workflow owns a serial request hook, per-rule positions, and a map of logical call identities to responses. Ordinary executors and workflow bodies request a decision at their existing execution boundary. Durable result streams deliver the decision; root replay reconstructs positions and deduplicates calls. The original root remains the playback owner across session handoffs. Checkpoint version 12 prevents older deployments from accepting a stubbed session and silently executing live tools. Local descendants use its opaque hook token and root id. State holds playback records, never a simulated external database or user code.

The first stub failure is recorded before its response is released. The eval runner reads the session's authenticated stub status before grading completion. Output conversion failures are recorded too. Parallel calls are admitted serially, without imposing a global expected call script.

## Authorization

Reuse existing route authentication. Configure `eveChannel({ auth, allowToolStubs: { subjects: evalSubjects } })` with the eval runners' subjects. Reuse the existing `*` subject-pattern matcher; do not inherit OIDC's implicit current-project acceptance. An omitted policy, empty list, or missing caller subject grants no replacement permission. A callback remains available for custom claims and subjectless authenticators such as local development.

Bind sessions and local descendants to the verified principal independently of `onMessage` projection. Recheck ownership and permission on continuation, approvals, controls, and streams. An eval bearer token does not implicitly grant overrides. Playback hooks have unguessable tokens; caller-supplied context cannot manufacture a trusted scope.

## Verification

Behavior tests cover matching, ambiguous selection, sequence exhaustion, concurrent admission, replay, handoff, descendants, whole-agent replacement, approvals, selected failures, and authorization. An HTTP fixture eval exercises ten concurrent calls, another turn, and an independent session across CI workflow worlds. Measure the extra workflow dispatch/stream latency in those worlds before claiming production performance.

Full stateful mocks, arbitrary functions, callback connections, per-turn reconfiguration, and mixing live and mocked calls within a persistent tool are excluded.
