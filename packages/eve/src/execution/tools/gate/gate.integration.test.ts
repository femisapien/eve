import { describe, expect, it } from "vitest";

import { sessionCommandHookToken } from "#execution/session-inbox/address.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { workflowEntry } from "#execution/session/entry.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { buildWorkflowToolSerializedContext } from "#internal/testing/workflow-tool-run-harness.js";
import { start } from "#internal/workflow/runtime.js";
import type { InputRequestedStreamEvent } from "#protocol/message.js";
import { deployServiceWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { always, once } from "#tools/approval/policies.js";
import { defineTool } from "#tools/definition.js";
import {
  defineWorkflowTool,
  type WorkflowExecuteToolDefinition,
} from "#tools/workflow-definition.js";

const SERVICE_INPUT_SCHEMA = {
  additionalProperties: false,
  properties: { service: { type: "string" } },
  required: ["service"],
  type: "object",
} as const;

/** Alice's release tools, each asking a person before it runs. */
const GATED_TOOLS = {
  // A plain tool runs in the gate's own step once a person approves.
  plain: (sent: string[]) =>
    defineTool({
      approval: always(),
      description: "Send Alice's release report for a service.",
      execute: ({ service }: { service: string }) => {
        sent.push(service);
        return { sent: service };
      },
      inputSchema: SERVICE_INPUT_SCHEMA,
    }),
  // A workflow tool's own run asks before its body starts.
  workflow: () =>
    defineWorkflowTool({
      approval: always(),
      description: "Deploy Alice's release for a service.",
      execute: deployServiceWorkflow as WorkflowExecuteToolDefinition["execute"],
      inputSchema: SERVICE_INPUT_SCHEMA,
    }),
};

describe("gated tool calls", () => {
  it.each([
    { decision: "approve", kind: "plain", output: { sent: "api" }, tool: "send_report" },
    { decision: "cancel", kind: "plain", output: undefined, tool: "send_report" },
    { decision: "approve", kind: "workflow", output: { plan: "plan:api" }, tool: "deploy_service" },
  ] as const)(
    "answers a $kind call with a receipt, then runs it only after a person approves ($decision)",
    async ({ decision, kind, output, tool }) => {
      const sent: string[] = [];
      const runtime = await createTestRuntime({
        agent: { name: `gated-${kind}-${decision}` },
        modules: [
          {
            loadNamespace: async () => ({ default: GATED_TOOLS[kind](sent) }),
            logicalPath: `tools/${tool}.ts`,
          },
        ],
      });

      await runtime.run(async () => {
        const run = await start(workflowEntry, [
          {
            input: { message: `Run ${tool} with service "api"` },
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            serializedContext: buildWorkflowToolSerializedContext({
              continuationToken: `http:gated-${kind}-${decision}`,
              requestInput: true,
            }),
          },
        ]);
        const stream = captureTurnEvents(run);
        try {
          const asked = await stream.nextTurn();
          const [started] = filterEventsByType(asked, "task.started");
          const request = (
            filterEventsByType(asked, "input.requested")[0] as InputRequestedStreamEvent
          ).data;
          expect(request.taskId).toBe(started?.data.taskId);
          expect(request.requests).toMatchObject([
            {
              action: { toolName: tool },
              kind: "tool-approval",
              options: [{ id: "approve" }, { id: "cancel" }],
              prompt: expect.stringMatching(/^Approve /u),
            },
          ]);
          expect(filterEventsByType(asked, "action.result")).toMatchObject([
            {
              data: {
                result: { output: expect.stringContaining("waiting for a person's approval") },
              },
            },
          ]);
          expect(sent).toEqual([]);

          await resumeSessionInbox(sessionCommandHookToken(run.runId), {
            kind: "send",
            payload: {
              inputResponses: [{ optionId: decision, requestId: request.requests[0]!.requestId }],
            },
          });

          const answered = await stream.nextTurn();
          expect(filterEventsByType(answered, "input.resolved")).toMatchObject([
            {
              data: { resolutions: [{ outcome: decision === "approve" ? "approved" : "denied" }] },
            },
          ]);
          const [settled] = filterEventsByType(answered, "task.settled");
          expect(settled?.data).toMatchObject(
            output === undefined
              ? { error: { message: expect.stringContaining("declined") }, status: "failed" }
              : { output, status: "completed" },
          );
          expect(settled?.data.taskId).toBe(started?.data.taskId);
          expect(sent).toEqual(kind === "plain" && output !== undefined ? ["api"] : []);
          expect(filterEventsByType(answered, "turn.completed")).toHaveLength(1);
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });
    },
    60_000,
  );

  it("takes a plain-text approve as the answer, and once() runs later calls without asking", async () => {
    const sent: string[] = [];
    const runtime = await createTestRuntime({
      agent: { name: "gated-once-text" },
      modules: [
        {
          loadNamespace: async () => ({
            default: defineTool({
              approval: once(),
              description: "Send Alice's release report for a service.",
              execute: ({ service }: { service: string }) => {
                sent.push(service);
                return { sent: service };
              },
              inputSchema: SERVICE_INPUT_SCHEMA,
            }),
          }),
          logicalPath: "tools/send_report.ts",
        },
      ],
    });

    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          input: { message: 'Run send_report with service "api"' },
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          serializedContext: buildWorkflowToolSerializedContext({
            continuationToken: "http:gated-once-text",
            requestInput: true,
          }),
        },
      ]);
      const stream = captureTurnEvents(run);
      const send = (payload: { readonly message: string }) =>
        resumeSessionInbox(sessionCommandHookToken(run.runId), { kind: "send", payload });
      try {
        const asked = await stream.nextTurn();
        expect(filterEventsByType(asked, "input.requested")).toHaveLength(1);

        await send({ message: "approve" });
        const answered = await stream.nextTurn();
        expect(filterEventsByType(answered, "input.resolved")).toMatchObject([
          { data: { resolutions: [{ outcome: "approved" }] } },
        ]);
        expect(filterEventsByType(answered, "message.received")).toHaveLength(0);
        expect(sent).toEqual(["api"]);

        await send({ message: 'Run send_report with service "web"' });
        const again = await stream.nextTurn();
        expect(filterEventsByType(again, "input.requested")).toHaveLength(0);
        expect(filterEventsByType(again, "task.started")).toHaveLength(0);
        expect(sent).toEqual(["api", "web"]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  }, 60_000);
});
