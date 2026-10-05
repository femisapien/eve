import { describe, expect, it } from "vitest";
import { getWorld, start } from "#internal/workflow/runtime.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext, handoffFollowUp } from "#internal/testing/entry-test-helpers.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { workflowEntry } from "#execution/session/entry.js";
import { dispatchWorkflowSessionCommand } from "#execution/workflow-runtime.js";
import { readStubFailure } from "#execution/tool-stubs/steps.js";
import { STUB_CONTEXT_KEY, STUB_OWNER_ATTRIBUTE } from "#tool-stubs/types.js";
import { defineTool } from "#tools/definition.js";
import { createWorkflowToolRuntime } from "#internal/testing/workflow-tool-run-harness.js";
import { failingDeployWorkflow } from "#internal/testing/workflow-tool-fixtures.js";
import { always } from "#tools/approval/policies.js";

describe("tool replacement through the session runtime", () => {
  it("records output conversion failures and never falls back to the live executor", async () => {
    let liveCalls = 0;
    const runtime = await createTestRuntime({
      modules: [
        {
          logicalPath: "tools/deploy_service.ts",
          loadNamespace: async () => ({
            default: defineTool({
              description: "Deploy a service.",
              inputSchema: {
                type: "object",
                properties: { service: { type: "string" } },
                required: ["service"],
              },
              execute: () => {
                liveCalls++;
                return "live";
              },
              toModelOutput: () => {
                throw new Error("Invalid deployment result.");
              },
            }),
          }),
        },
      ],
    });
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: {
              owner: "alice",
              token: "failed-output-playback",
              rules: [{ id: "deploy", tool: "deploy_service", response: "stubbed" }],
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        await stream.nextTurn();
        expect(liveCalls).toBe(0);
        expect(await readStubFailure(run.runId)).toBe(
          'Stubbed tool "deploy_service" failed during output processing.',
        );
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("inherits root playback in a real local descendant", async () => {
    const runtime = await createTestRuntime({
      modules: [
        {
          logicalPath: "tools/deploy_service.ts",
          loadNamespace: async () => ({
            default: defineTool({
              description: "Deploy a service.",
              inputSchema: {
                type: "object",
                properties: { service: { type: "string" } },
                required: ["service"],
              },
              execute: () => {
                throw new Error("Live execution must not run.");
              },
            }),
          }),
        },
      ],
    });
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: {
              owner: "alice",
              token: "inherited-playback",
              rules: [
                {
                  id: "deploy",
                  tool: "deploy_service",
                  responses: [{ state: "root" }, { state: "child" }],
                },
              ],
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        await stream.nextTurn();
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: {
            kind: "send",
            payload: { message: 'Delegate to a subagent: Run deploy_service with service "api"' },
          },
        });
        const events = await stream.nextTurn();
        const children = filterEventsByType(events, "agent.started");
        expect(children).toHaveLength(1);
        const child = await (await getWorld()).runs.get(children[0]!.data.sessionId);
        expect(child.attributes?.[STUB_OWNER_ATTRIBUTE]).toBe("alice");
        const settlements = filterEventsByType(events, "task.settled");
        expect(
          settlements.some((event) => JSON.stringify(event.data.output).includes("child")),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("replaces the whole agent tool without starting a remote or local agent", async () => {
    const runtime = await createTestRuntime();
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: "Delegate to a subagent: Say hello." },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: {
              owner: "alice",
              token: "whole-agent-playback",
              rules: [{ id: "agent", tool: "agent", response: "Hello from the stub." }],
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const events = await stream.nextTurn();
        expect(filterEventsByType(events, "agent.started")).toEqual([]);
        expect(
          filterEventsByType(events, "task.settled").map((event) => event.data),
        ).toContainEqual(
          expect.objectContaining({ status: "completed", output: "Hello from the stub." }),
        );
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("keeps approval gates and does not consume a response for a denied call", async () => {
    const runtime = await createTestRuntime({
      modules: [
        {
          logicalPath: "tools/deploy_service.ts",
          loadNamespace: async () => ({
            default: defineTool({
              description: "Deploy a service.",
              inputSchema: {
                type: "object",
                properties: { service: { type: "string" } },
                required: ["service"],
              },
              approval: always(),
              execute: () => {
                throw new Error("Live execution must not run.");
              },
            }),
          }),
        },
      ],
    });
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            "eve.capabilities": { requestInput: true },
            [STUB_CONTEXT_KEY]: {
              owner: "alice",
              token: "approval-playback",
              rules: [
                {
                  id: "deploy",
                  tool: "deploy_service",
                  responses: [{ first: true }, { first: false }],
                },
              ],
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const pending = await stream.nextTurn();
        const request = filterEventsByType(pending, "input.requested")[0]!.data.requests[0]!;
        expect(filterEventsByType(pending, "action.result")).toEqual([]);
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: {
            kind: "send",
            payload: { inputResponses: [{ requestId: request.requestId, optionId: "deny" }] },
          },
        });
        await stream.nextTurn();
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: { kind: "send", payload: { message: 'Run deploy_service with service "api"' } },
        });
        const retry = await stream.nextTurn();
        const next = filterEventsByType(retry, "input.requested")[0]!.data.requests[0]!;
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: {
            kind: "send",
            payload: { inputResponses: [{ requestId: next.requestId, optionId: "approve" }] },
          },
        });
        const approved = await stream.nextTurn();
        expect(
          filterEventsByType(approved, "action.result").map((event) => event.data.result),
        ).toContainEqual(expect.objectContaining({ output: { first: true } }));
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
  it("keeps sequence progress across a deployment handoff and runs unmatched calls normally", async () => {
    let liveCalls = 0;
    const runtime = await createTestRuntime({
      modules: [
        {
          logicalPath: "tools/deploy_service.ts",
          loadNamespace: async () => ({
            default: defineTool({
              description: "Deploy a service.",
              inputSchema: {
                type: "object",
                properties: { service: { type: "string" } },
                required: ["service"],
              },
              execute: async () => {
                liveCalls++;
                return { state: "live" };
              },
            }),
          }),
        },
      ],
    });
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: {
              owner: "alice",
              token: "ordinary-tool-playback",
              rules: [
                {
                  id: "api",
                  tool: "deploy_service",
                  match: { service: { const: "api" } },
                  responses: [{ state: "pending" }, { state: "completed" }],
                },
              ],
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const first = await stream.nextTurn();
        expect(
          filterEventsByType(first, "action.result").map((event) => event.data.result),
        ).toContainEqual(expect.objectContaining({ output: { state: "pending" } }));
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: handoffFollowUp(
            "dpl_successor",
            'Run deploy_service with service "api"',
            "stub-handoff",
          ),
        });
        const second = await stream.nextTurn();
        expect(
          filterEventsByType(second, "action.result").map((event) => event.data.result),
        ).toContainEqual(expect.objectContaining({ output: { state: "completed" } }));
        await dispatchWorkflowSessionCommand({
          sessionId: run.runId,
          command: { kind: "send", payload: { message: 'Run deploy_service with service "web"' } },
        });
        const third = await stream.nextTurn();
        expect(
          filterEventsByType(third, "action.result").map((event) => event.data.result),
        ).toContainEqual(expect.objectContaining({ output: { state: "live" } }));
        expect(liveCalls).toBe(1);
        expect(await readStubFailure(run.runId)).toBeUndefined();
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });

  it("replaces a workflow body while retaining its normal result events", async () => {
    const runtime = await createWorkflowToolRuntime({
      agentName: "stubbed-workflow",
      execute: failingDeployWorkflow,
      toolName: "deploy_service",
    });
    await runtime.run(async () => {
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: { message: 'Run deploy_service with service "api"' },
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: {
              owner: "alice",
              token: "workflow-tool-playback",
              rules: [{ id: "deploy", tool: "deploy_service", response: { state: "stubbed" } }],
            },
          },
        },
      ]);
      const stream = captureTurnEvents(run);
      try {
        const events = await stream.nextTurn();
        expect(
          filterEventsByType(events, "action.result").map((event) => event.data.result),
        ).toContainEqual(expect.objectContaining({ output: { state: "stubbed" } }));
        expect(filterEventsByType(events, "turn.failed")).toEqual([]);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });
  });
});
