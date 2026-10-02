import { describe, expect, it } from "vitest";

import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { buildWorkflowToolSerializedContext } from "#internal/testing/workflow-tool-run-harness.js";
import { start } from "#internal/workflow/runtime.js";

describe("the turn's budget question", () => {
  it("holds the turn over budget, runs the same turn on Continue, cancels it on Stop, and withdraws it on cancel", async () => {
    const runtime = await createTestRuntime({
      agent: { limits: { maxInputTokensPerSession: 1 }, name: "budget-question" },
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: "Alice asks for the weekly summary." },
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:budget-question",
            requestInput: true,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      const send = (payload: Record<string, unknown>) =>
        resumeSessionInbox(sessionCommandHookToken(run.runId), { kind: "send", payload });
      try {
        const first = await stream.nextTurn();
        expect(filterEventsByType(first, "turn.completed")).toHaveLength(1);

        await send({ message: "Alice asks for last week's summary too." });
        const asked = await stream.nextTurn();
        const [requested] = filterEventsByType(asked, "input.requested");
        const request = requested!.data.requests[0]!;
        expect(request).toMatchObject({
          kind: "session-limit",
          options: [{ id: "continue" }, { id: "stop" }],
        });
        expect(filterEventsByType(asked, "message.completed")).toHaveLength(0);
        expect(filterEventsByType(asked, "turn.completed")).toHaveLength(0);
        const turnId = requested!.data.turnId;

        await send({ inputResponses: [{ optionId: "continue", requestId: request.requestId }] });
        const granted = await stream.nextTurn();
        expect(filterEventsByType(granted, "input.resolved")).toMatchObject([
          { data: { resolutions: [{ kind: "session-limit", outcome: "answered" }], turnId } },
        ]);
        expect(filterEventsByType(granted, "message.completed")).toHaveLength(1);
        expect(filterEventsByType(granted, "turn.completed")).toMatchObject([{ data: { turnId } }]);

        await send({ message: "Alice asks for the monthly summary." });
        const askedAgain = await stream.nextTurn();
        const again = filterEventsByType(askedAgain, "input.requested")[0]!.data.requests[0]!;
        expect(again.requestId).not.toBe(request.requestId);

        await send({ inputResponses: [{ optionId: "stop", requestId: again.requestId }] });
        const stopped = await stream.nextTurn();
        expect(filterEventsByType(stopped, "input.resolved")).toMatchObject([
          { data: { resolutions: [{ outcome: "answered", requestId: again.requestId }] } },
        ]);
        expect(filterEventsByType(stopped, "turn.cancelled")).toHaveLength(1);
        expect(filterEventsByType(stopped, "message.completed")).toHaveLength(0);

        // Cancelling a turn that holds on its budget question withdraws the question.
        await send({ message: "Alice asks for the quarterly summary." });
        const third = filterEventsByType(await stream.nextTurn(), "input.requested")[0]!.data;
        await resumeSessionInbox(sessionCommandHookToken(run.runId), {
          kind: "cancel",
          turnId: third.turnId,
        });
        const cancelled = await stream.nextTurn();
        expect(filterEventsByType(cancelled, "input.resolved")).toMatchObject([
          {
            data: {
              resolutions: [{ outcome: "cancelled", requestId: third.requests[0]!.requestId }],
            },
          },
        ]);
        expect(filterEventsByType(cancelled, "turn.cancelled")).toHaveLength(1);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);
});
