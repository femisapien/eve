import { describe, expect, it, vi } from "vitest";
import { z } from "#compiled/zod/index.js";
import { resolveApprovalPolicy } from "#approval/definition.js";
import { loadContext } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { defineScheduleSubscription } from "#public/schedules/subscription.js";
import { schedules } from "#public/experimental/schedules/client.js";
import { inMemoryScheduleProvider } from "#public/schedules/providers/in-memory.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";
import type { ScheduleOccurrenceEvent, ScheduleRecord } from "#public/schedules/subscription.js";

const alice = {
  attributes: {},
  authenticator: "fixture",
  principalId: "alice",
  principalType: "user",
};

async function bindCaller() {
  loadContext().set(AuthKey, alice);
  loadContext().set(
    BundleKey,
    await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
    }),
  );
}

describe("schedule subscription invocation", () => {
  it("creates through the included tool without altering the configured approval policy", async () => {
    const approval = vi.fn(() => "user-approval" as const);
    const subscription = defineScheduleSubscription({
      schema: z.object({ task: z.string() }),
      provider: inMemoryScheduleProvider(),
      auth: () => alice,
      run: () => {},
      tools: { approval: { create: approval } },
    });
    const app = await createTestRuntime({
      modules: [
        {
          logicalPath: "schedules/requests.ts",
          loadNamespace: async () => ({ default: subscription }),
        },
      ],
    });
    await app.runAsSession(undefined, async () => {
      await bindCaller();
      const wrapper = app.manifest.dynamicTools.find(
        (entry) => entry.logicalPath === "tools/schedule__requests.ts",
      )!;
      const dynamic = app.moduleMap.nodes.__root__!.modules[wrapper.sourceId]!
        .default as ReturnType<typeof import("#dynamic/definition.js").defineDynamic>;
      const tools = (await dynamic.events["turn.started"]!(undefined, {
        model: null,
        session: { id: "alice", auth: { current: alice, initiator: null } },
        channel: {},
        messages: [],
      })) as Record<string, DynamicToolEntry>;
      const create = tools.schedule__requests__create!;
      const input = {
        name: "joke",
        expression: { type: "delay" as const, minutes: 1 },
        payload: { task: "A joke" },
      };
      expect(await resolveApprovalPolicy(create.approval!)({ toolInput: input } as never)).toBe(
        "user-approval",
      );
      expect(approval).toHaveBeenCalledOnce();
      const created = (await create.execute(input, {} as never)) as ScheduleRecord;
      await expect((await schedules(subscription)).get(created.name)).resolves.toMatchObject({
        displayName: "joke",
      });
    });
  });

  it("dispatches prepared data unchanged, preserves occurrence identity, and revalidates the creator", async () => {
    let allowed = true;
    let preparations = 0;
    const messages: string[] = [];
    const outcomes: ScheduleOccurrenceEvent[] = [];
    const subscription = defineScheduleSubscription({
      schema: z.object({ task: z.string() }).strict(),
      provider: inMemoryScheduleProvider(),
      async prepare(input, context) {
        preparations += 1;
        return { message: input.task, author: context.session.auth.current!.principalId };
      },
      auth: ({ principal, payload }) =>
        allowed && payload.author === principal.principalId ? alice : null,
      run: ({ payload }) => {
        messages.push(payload.message);
      },
      events: {
        "occurrence.dispatched": (event) => {
          outcomes.push(event);
        },
      },
    });
    const app = await createTestRuntime({
      modules: [
        {
          logicalPath: "schedules/prepared.ts",
          loadNamespace: async () => ({ default: subscription }),
        },
      ],
    });
    await app.runAsSession(undefined, async () => {
      await bindCaller();
      const client = await schedules(subscription);
      const created = await client.create({
        name: "prepared",
        expression: { type: "delay", minutes: 5 },
        payload: { task: "A joke" },
      });
      await client.get(created.name);
      await client.update(created.name, { expression: { type: "delay", minutes: 10 } });
      await client.invoke(created.name);
      await client.invoke(created.name);
      expect(preparations).toBe(1);
      expect(messages).toEqual(["A joke", "A joke"]);
      expect(outcomes.map((event) => event.sessionIds)).toEqual([[], []]);
      expect(outcomes[0]!.occurrence).toMatchObject({
        name: created.name,
        displayName: "prepared",
      });
      expect(outcomes[0]!.executionId).not.toBe(outcomes[1]!.executionId);
      allowed = false;
      await expect(client.invoke(created.name)).rejects.toThrow("no longer authorized");
      expect(messages).toHaveLength(2);
      expect(outcomes).toHaveLength(2);
    });
  });
});
