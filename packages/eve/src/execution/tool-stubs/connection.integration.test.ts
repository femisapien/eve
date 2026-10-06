import { toolStubProvider } from "#context/providers/tool-stubs.js";
import { describe, expect, it, vi } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey, ToolStubsKey } from "#context/keys.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import { getWorld, start } from "#internal/workflow/runtime.js";
import { workflowEntry } from "#execution/session/entry.js";
import { resolveConnectionTools } from "#execution/tools/connection-tools.js";
import { recordToolStubFailure } from "#tool-stubs/execute.js";
import { readStubFailure } from "#execution/tool-stubs/steps.js";
import { STUB_CONTEXT_KEY, STUB_FAILURE_NAMESPACE, type ToolStub } from "#tool-stubs/types.js";
import type { ConnectionClient } from "#shared/connection-types.js";
import type { ToolContext } from "#tools/definition.js";

describe("connection operation stubs", () => {
  it("validates discovered input before replacing a qualified operation and leaves unmatched calls live", async () => {
    let liveCalls = 0;
    const runtime = await createTestRuntime();
    await runtime.run(async () => {
      const rules: readonly ToolStub[] = [
        {
          id: "open",
          tool: "linear__list_issues",
          match: { status: { const: "open" } },
          response: { issues: ["milk"] },
        },
      ];
      const token = "connection-stub-playback";
      const run = await start(workflowEntry, [
        {
          kind: "initial",
          ownerDeploymentId: "dpl_inline",
          input: {},
          serializedContext: {
            ...buildSerializedContext({ channelKind: "http" }),
            [STUB_CONTEXT_KEY]: { token, rules },
          },
        },
      ]);
      try {
        await waitForHook({ runId: run.runId }, { token });
        const client: ConnectionClient = {
          close: async () => {},
          connect: async () => {},
          getToolMetadata: async () => [
            {
              name: "list_issues",
              description: "List issues.",
              inputSchema: {
                type: "object",
                properties: { status: { type: "string" } },
                required: ["status"],
              },
            },
          ],
          executeTool: async () => {
            liveCalls++;
            return { content: [{ type: "text", text: "live" }] };
          },
        };
        const connection = {
          sourceId: "test:linear",
          sourceKind: "module" as const,
          logicalPath: "connections/linear.ts",
          connectionName: "linear",
          description: "Issues",
          protocol: "mcp" as const,
          url: "https://linear.example/mcp",
        };
        const context = new ContextContainer();
        context.set(SessionKey, {
          sessionId: run.runId,
          auth: { current: null, initiator: null },
          turn: { id: "turn-0", sequence: 0 },
        });
        context.set(ToolStubsKey, { token, rules, rootSessionId: run.runId });
        context.set(ConnectionRegistryKey, {
          dispose: async () => {},
          getClient: () => client,
          getConnectionApproval: () => undefined,
          getConnectionNames: () => ["linear"],
          getConnections: () => [connection],
        });
        context.setVirtualContext(toolStubProvider.key, toolStubProvider.create(context)!.value);
        await contextStorage.run(context, async () => {
          const execute = resolveConnectionTools()!.connection_execute!.execute!;
          const call = (callId: string, input: unknown) =>
            execute({ connection: "linear", tool: "list_issues", input }, {
              callId,
            } as ToolContext);
          await expect(call("invalid", { status: 42 })).rejects.toThrow(/Invalid input/);
          expect(await call("stubbed", { status: "open", limit: 10 })).toEqual({
            issues: ["milk"],
          });
          expect(liveCalls).toBe(0);
          await call("live", { status: "closed" });
          expect(liveCalls).toBe(1);
          // Output conversion belongs to the enclosing connection_execute tool.
          await recordToolStubFailure("connection_execute", "live");
          expect(await readStubFailure(run.runId)).toBeUndefined();
          const world = await getWorld();
          const append = world.streams.write.bind(world.streams);
          const failureSuffix = Buffer.from(STUB_FAILURE_NAMESPACE).toString("base64url");
          let delayedFailure: Promise<void> | undefined;
          const write = vi.spyOn(world.streams, "write").mockImplementation(async (...args) => {
            if (args[1].endsWith(`_${failureSuffix}`) && delayedFailure === undefined) {
              delayedFailure = new Promise((resolve) => setTimeout(resolve, 1_200));
              await delayedFailure;
            }
            return await append(...args);
          });
          try {
            await recordToolStubFailure("connection_execute", "stubbed");
            expect(await readStubFailure(run.runId)).toBe(
              'Stubbed tool "connection_execute" failed during output processing.',
            );
            expect(delayedFailure).toBeDefined();
          } finally {
            await delayedFailure;
            write.mockRestore();
          }
        });
      } finally {
        await run.cancel();
      }
    });
  });
});
