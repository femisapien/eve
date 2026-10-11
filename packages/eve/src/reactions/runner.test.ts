import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey, SessionKey } from "#context/keys.js";
import {
  enterSessionProjection,
  enterSessionProjectionAt,
} from "#harness/session-machine/current.js";
import { initialSessionProjection } from "#protocol/session-projection.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { defineInstructions } from "#public/definitions/instructions.js";
import { defineState } from "#public/definitions/state.js";
import { defineTool } from "#tools/definition.js";
import { dynamicTools } from "./kinds/tool.js";
import { restoreReactions, runReactions, slotsOf } from "./runner.js";
import { cancel, compact } from "#public/definitions/hook.js";
import { hasPendingCompaction } from "./kinds/hook.js";
import { forgetSessionLive, readReactionsState, writeReactionsState } from "./state.js";

const user = (content: string): ModelMessage => ({ content, role: "user" });

function written(line: number, type = "turn.started", data: object = {}) {
  return [
    {
      event: { data, meta: { position: { index: 0, line } }, type },
      position: { index: 0, line },
      progress: false,
      view: {},
    },
  ] as never;
}

/** A session whose bundle declares one dynamic tool resolver, and optionally hooks. */
function session(
  resolver: {
    readonly select?: (view: never, ctx: never) => unknown;
    readonly resolve?: (selected: never, ctx: never) => unknown;
    readonly build?: (input: never) => unknown;
  },
  hooks: readonly object[] = [],
  instructions: readonly object[] = [],
) {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, `session-${Math.random()}`);
  ctx.set(BundleKey, {
    resolvedAgent: {
      dynamicInstructionsResolvers: instructions,
      dynamicSkillResolvers: [],
      dynamicToolResolvers: [
        { logicalPath: "tools/count.ts", slug: "count", sourceId: "tools/count.ts", ...resolver },
      ],
      hooks,
      memories: [],
    },
    subagentRegistry: { dynamicResolvers: [], preparedTools: [], subagentsByName: new Map() },
    toolRegistry: { toolsByName: new Map() },
    turnAgent: {},
  } as never);
  enterSessionProjection(ctx, undefined);
  return ctx;
}

/** Runs reactions inside the session's context, which hooks read. */
async function inSession(ctx: ContextContainer, input: Parameters<typeof runReactions>[1]) {
  if (ctx.get(SessionKey) === undefined) {
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: ctx.get(SessionIdKey),
    } as never);
  }
  await contextStorage.run(ctx, async () => await runReactions(ctx, input));
}

const countTool = (count: unknown) =>
  defineTool({
    description: `Count ${String(count)}.`,
    execute: async () => count,
    inputSchema: {},
  });

/** A tool whose `resolve` records each selection it fetches for, and whose `build` each build. */
const counted = (selections: unknown[], builds: unknown[] = []) => ({
  build: ((count: unknown) => {
    builds.push(count);
    return countTool(count);
  }) as never,
  resolve: ((selected: never) => {
    selections.push(selected);
    return selected;
  }) as never,
  select: ((view: { readonly messages: readonly ModelMessage[] }) => view.messages.length) as never,
});

const noTools = { build: (() => null) as never, select: (() => null) as never };

describe("runReactions", () => {
  it("resolves only when the selection changes", async () => {
    const selections: unknown[] = [];
    const ctx = session(counted(selections));

    await runReactions(ctx, { conversation: [user("a")], written: written(1) });
    await runReactions(ctx, { conversation: [user("a")], written: written(2) });
    await runReactions(ctx, { conversation: [user("a"), user("b")], written: written(3) });

    expect(selections).toEqual([1, 2]);
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["Count 2."]);
    expect(readReactionsState(ctx).latest).toMatchObject({ "*": 3, "turn.started": 3 });
  });

  it("skips a reaction that reads the conversation where the step has none, keeping its slot", async () => {
    const selections: unknown[] = [];
    const ctx = session(counted(selections));

    await runReactions(ctx, { conversation: [user("a")], written: written(1) });
    await runReactions(ctx, { written: written(2, "task.ended") });

    expect(selections).toEqual([1]);
    expect(slotsOf(ctx, "tool")).toHaveLength(1);
  });

  it("builds code in a fresh process from what the slot recorded, without resolving again", async () => {
    const selections: unknown[] = [];
    const builds: unknown[] = [];
    const ctx = session(counted(selections, builds));
    await runReactions(ctx, { conversation: [user("a"), user("b")], written: written(1) });

    forgetSessionLive(ctx.get(SessionIdKey)!);
    expect(dynamicTools(ctx)).toEqual([]);
    await restoreReactions(ctx);

    expect(selections).toEqual([2]);
    expect(builds).toEqual([2, 2]);
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["Count 2."]);
  });

  it("builds from the latest input even when what the model is offered is unchanged", async () => {
    // Both scopes offer the same tool; only the code that closes over the scope differs.
    const built: string[] = [];
    const ctx = session({
      build: ((scope: string) => {
        built.push(scope);
        return defineTool({
          description: "Forget a memory.",
          execute: async () => scope,
          inputSchema: {},
        });
      }) as never,
      select: ((view: { readonly messages: readonly ModelMessage[] }) =>
        String(view.messages.at(-1)?.content)) as never,
    });
    await runReactions(ctx, { conversation: [user("tenant-a")], written: written(1) });
    await runReactions(ctx, { conversation: [user("tenant-b")], written: written(2) });
    expect(slotsOf(ctx, "tool")[0]?.slot.input).toBe("tenant-b");

    forgetSessionLive(ctx.get(SessionIdKey)!);
    await restoreReactions(ctx);

    expect(built).toEqual(["tenant-a", "tenant-b", "tenant-b"]);
  });

  it("withdraws a slot whose build offers something else in a fresh process", async () => {
    let description = "Offered.";
    const ctx = session({
      build: (() =>
        defineTool({ description, execute: async () => "ran", inputSchema: {} })) as never,
      select: (() => null) as never,
    });
    await runReactions(ctx, { written: written(1) });

    description = "Changed.";
    forgetSessionLive(ctx.get(SessionIdKey)!);
    await restoreReactions(ctx);

    expect(dynamicTools(ctx)).toEqual([]);
    expect(slotsOf(ctx, "tool").map(({ slot }) => slot.error)).toEqual([
      expect.stringContaining("built something other than what this session was offered"),
    ]);
  });

  it("requires JSON from a resolve whose value build creates", async () => {
    const ctx = session({
      build: ((tool: never) => tool) as never,
      resolve: (() => countTool(1)) as never,
      select: (() => null) as never,
    });
    await runReactions(ctx, { written: written(1) });

    expect(slotsOf(ctx, "tool").map(({ slot }) => slot.error)).toEqual([
      expect.stringContaining('The resolve of "tools/count.ts" must return JSON'),
    ]);
  });

  it("rejects a build that returns a promise, since build can't do I/O", async () => {
    const ctx = session({
      build: (async () => countTool(1)) as never,
      select: (() => null) as never,
    });
    await runReactions(ctx, { written: written(1) });

    expect(slotsOf(ctx, "tool").map(({ slot }) => slot.error)).toEqual([
      expect.stringContaining('The build of "tools/count.ts" returned a promise'),
    ]);
  });

  it("caps a selection at 64 KB", async () => {
    const ctx = session({
      build: (() => null) as never,
      select: (() => "x".repeat(70_000)) as never,
    });
    await runReactions(ctx, { written: written(1) });

    expect(slotsOf(ctx, "tool").map(({ slot }) => slot.error)).toEqual([
      expect.stringContaining("a selection is at most 64 KB"),
    ]);
  });

  it("keeps the model out of the view of reactions that run before it", async () => {
    const seen: unknown[] = [];
    const ctx = session(
      {
        build: (() => null) as never,
        select: ((view: { readonly model: unknown }) => {
          seen.push(view.model);
          return null;
        }) as never,
      },
      [
        {
          events: {},
          logicalPath: "hooks/modal.ts",
          resolve: () => null,
          select: (view: { readonly model: unknown }) => view.model,
          slug: "modal",
        },
      ],
    );
    await runReactions(ctx, { written: written(1) });

    // The tool runs after the model and reads it; the hook's select threw, so its slot is empty.
    expect(seen).toEqual([null]);
    expect(slotsOf(ctx, "hook").map(({ slot }) => slot.error)).toEqual([
      expect.stringContaining("view.model isn't available to a hook reaction"),
    ]);
  });

  it("compacts once per occurrence, without naming it", async () => {
    let imports = 1;
    const ctx = session(noTools, [
      {
        events: {},
        logicalPath: "hooks/imports.ts",
        resolve: () => compact(),
        select: () => imports,
        slug: "imports",
      },
    ]);
    await inSession(ctx, { written: written(1) });
    expect(hasPendingCompaction(ctx)).toBe(true);

    await inSession(ctx, { written: written(2, "context.started", { kind: "compaction" }) });
    expect(hasPendingCompaction(ctx)).toBe(false);
    // The same selection is the same occurrence, which already acted.
    writeReactionsState(ctx, { ...readReactionsState(ctx), latest: {} });
    await inSession(ctx, { written: written(3) });
    expect(hasPendingCompaction(ctx)).toBe(false);

    imports = 2;
    await inSession(ctx, { written: written(4) });
    expect(hasPendingCompaction(ctx)).toBe(true);
  });

  it("gives a hook's resolve a stable key for its occurrence", async () => {
    const occurrences: string[] = [];
    let turn = 1;
    const ctx = session(noTools, [
      {
        events: {},
        logicalPath: "hooks/notify.ts",
        resolve: (_selected: unknown, hookContext: { readonly occurrence: string }) => {
          occurrences.push(hookContext.occurrence);
          return null;
        },
        select: () => turn,
        slug: "notify",
      },
    ]);
    await inSession(ctx, { written: written(1) });
    turn = 2;
    await inSession(ctx, { written: written(2) });

    expect(occurrences).toHaveLength(2);
    expect(new Set(occurrences).size).toBe(2);
    expect(occurrences[0]).toContain(":notify:");
  });

  it("cancels the running turn once, and waits for a commit that can", async () => {
    const ctx = session(noTools, [
      {
        events: {},
        logicalPath: "hooks/stop.ts",
        resolve: () => cancel("Asked to stop."),
        select: () => null,
        slug: "stop",
      },
    ]);
    // A turn is running.
    enterSessionProjectionAt(ctx, { ...initialSessionProjection(), activeTurnId: "turn-1" });
    const stopped: unknown[] = [];

    await inSession(ctx, { written: written(1) });
    expect(stopped).toEqual([]);
    const cancelTurn = (cancel: unknown) => void stopped.push(cancel);
    await inSession(ctx, { cancelTurn, written: written(2) });
    await inSession(ctx, { cancelTurn, written: written(3) });

    expect(stopped).toEqual([{ hook: "hooks/stop.ts", reason: "Asked to stop." }]);
  });

  it("runs resolve and build outside the session's context, so they read only the selection", async () => {
    const counter = defineState("runner-test.counter", () => 7);
    const read = session({
      resolve: (() => counter.get()) as never,
      build: (() => null) as never,
      select: (() => null) as never,
    });
    const built = session({ build: (() => counter.get()) as never, select: (() => null) as never });
    const selected = session({
      build: ((count: number) => countTool(count)) as never,
      select: (() => counter.get()) as never,
    });
    await inSession(read, { written: written(1) });
    await inSession(built, { written: written(1) });
    await inSession(selected, { written: written(1) });

    for (const ctx of [read, built]) {
      expect(slotsOf(ctx, "tool").map(({ slot }) => slot.error)).toEqual([
        expect.stringContaining('"tools/count.ts" read session state in resolve or build'),
      ]);
    }
    expect(dynamicTools(selected).map((tool) => tool.description)).toEqual(["Count 7."]);
  });

  it("runs only hooks for a commit of streamed progress", async () => {
    let selects = 0;
    const ctx = session({
      build: (() => null) as never,
      select: (() => {
        selects += 1;
        return null;
      }) as never,
    });
    const [record] = written(1, "content.delta") as unknown as readonly object[];
    const delta = [{ ...record, progress: true }] as never;
    await runReactions(ctx, { written: delta });
    expect(selects).toBe(0);

    await runReactions(ctx, { written: written(2) });
    expect(selects).toBe(1);
  });

  it("withdraws the slot of a resolve that throws, retrying when the selection changes", async () => {
    let fail = false;
    let calls = 0;
    const ctx = session({
      build: (() =>
        defineTool({
          description: "Listed.",
          execute: async () => null,
          inputSchema: {},
        })) as never,
      resolve: (() => {
        calls += 1;
        if (fail) throw new Error("listing failed");
        return "listed";
      }) as never,
      select: ((view: { readonly latest: Record<string, number> }) =>
        view.latest["turn.started"] ?? null) as never,
    });

    await runReactions(ctx, { written: written(1) });
    expect(slotsOf(ctx, "tool")).toHaveLength(1);
    fail = true;
    await runReactions(ctx, { written: written(2) });

    expect(slotsOf(ctx, "tool").map(({ slot }) => slot.value)).toEqual([null]);
    expect(slotsOf(ctx, "tool").every(({ live }) => live === undefined)).toBe(true);
    // The failed selection waits for a new one rather than retrying on every commit.
    await runReactions(ctx, { written: written(3, "step.started") });
    expect(calls).toBe(2);
    await runReactions(ctx, { written: written(4) });
    expect(calls).toBe(3);
  });

  it("resolves again under a new runtime revision", async () => {
    const selections: unknown[] = [];
    const ctx = session(counted(selections));
    await restoreReactions(ctx, { revision: "r1" });
    await runReactions(ctx, { conversation: [user("a")], written: written(1) });
    await restoreReactions(ctx, { revision: "r2" });
    await runReactions(ctx, { conversation: [user("a")], written: written(2) });

    expect(selections).toEqual([1, 1]);
  });

  it("builds a fresh process's code under a new revision, then resolves again at its first commit", async () => {
    const selections: unknown[] = [];
    const builds: unknown[] = [];
    const ctx = session(counted(selections, builds));
    await restoreReactions(ctx, { revision: "r1" });
    await runReactions(ctx, { conversation: [user("a")], written: written(1) });
    forgetSessionLive(ctx.get(SessionIdKey)!);
    await restoreReactions(ctx, { revision: "r2" });
    expect(dynamicTools(ctx).map((tool) => tool.description)).toEqual(["Count 1."]);
    await runReactions(ctx, { conversation: [user("a")], written: written(2) });

    // Once to choose under r1; under r2, once to build for the step and once to resolve again.
    expect(selections).toEqual([1, 1]);
    expect(builds).toEqual([1, 1, 1]);
    expect(slotsOf(ctx, "tool")[0]?.slot.revision).toBe("r2");
  });

  it("keeps a data slot under a new runtime revision until its selection changes", async () => {
    const resolved: unknown[] = [];
    const ctx = session(
      noTools,
      [],
      [
        {
          logicalPath: "instructions/policy.ts",
          resolve: (selected: unknown) => {
            resolved.push(selected);
            return defineInstructions({ markdown: `Policy ${String(selected)}.` });
          },
          select: (view: { readonly messages: readonly ModelMessage[] }) => view.messages.length,
          slug: "policy",
          sourceId: "instructions/policy.ts",
        },
      ],
    );
    await restoreReactions(ctx, { revision: "r1" });
    await runReactions(ctx, { conversation: [user("a")], written: written(1) });
    await restoreReactions(ctx, { revision: "r2" });
    await runReactions(ctx, { conversation: [user("a")], written: written(2) });
    expect(resolved).toEqual([1]);

    await runReactions(ctx, { conversation: [user("a"), user("b")], written: written(3) });
    expect(resolved).toEqual([1, 2]);
  });
});
