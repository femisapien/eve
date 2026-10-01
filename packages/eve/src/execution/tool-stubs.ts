/**
 * Eval tool stubs: a session created with a stub set from `evals/stubs/` runs
 * each stubbed tool's stub in place of its `execute`.
 *
 * Only the local server `eve eval` starts accepts stub sets
 * ({@link resolveEveEvaluationToolStubsDirectory}). The model, approval
 * policies, and result handling see the real tool; only `execute` changes.
 */

import { pathToFileURL } from "node:url";

import { contextStorage } from "#context/container.js";
import { ToolStubSetKey } from "#context/keys.js";
import type { ToolStubs } from "#evals/tool-stubs.js";
import { TurnFailingToolError } from "#harness/tool-turn-failure.js";
import { resolveEveEvaluationToolStubsDirectory } from "#internal/application/dev-environment.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ToolContext } from "#tools/definition.js";

type ToolStubSetsModule = typeof import("#evals/tool-stub-sets.js");

/** Result of checking a session-create request's `stubs` field. */
export type ToolStubSetSelection =
  | { readonly ok: true; readonly set: string }
  | { readonly ok: false; readonly error: string };

/**
 * Checks that this server accepts stubs and that `name` is a set in
 * `evals/stubs/` that loads.
 */
export async function selectToolStubSet(name: string): Promise<ToolStubSetSelection> {
  const directory = resolveEveEvaluationToolStubsDirectory();
  if (directory === undefined) {
    return {
      ok: false,
      error:
        "'stubs' is accepted only by the local server that `eve eval` starts. This server was not " +
        "started by `eve eval`, so it runs every tool for real. Evals against `eve eval --url` " +
        "targets cannot use tool stubs.",
    };
  }
  const sets = await loadToolStubSetsModule();
  const names = await sets.listToolStubSets(directory);
  if (!names.includes(name)) {
    return {
      ok: false,
      error:
        names.length === 0
          ? `Unknown tool stub set "${name}": evals/stubs/ has no stub sets.`
          : `Unknown tool stub set "${name}". Sets in evals/stubs/: ${names.join(", ")}.`,
    };
  }
  try {
    await sets.loadToolStubSet(directory, name);
  } catch (error) {
    return {
      ok: false,
      error: `Tool stub set "${name}" failed to load: ${toErrorMessage(error)}`,
    };
  }
  return { ok: true, set: name };
}

/**
 * Wraps an authored, extension, or dynamic tool's `execute`. In a session with
 * a stub set, the call runs the set's stub for the tool, and a tool without a
 * stub fails the turn. Other sessions run `execute` unchanged.
 */
export function withToolStub<TInput>(
  execute: (toolInput: TInput, ctx: ToolContext) => unknown,
): (toolInput: TInput, ctx: ToolContext) => unknown {
  return (toolInput, ctx) => {
    const set = contextStorage.getStore()?.get(ToolStubSetKey);
    if (set === undefined) return execute(toolInput, ctx);
    return runToolStub({ ctx, set, toolInput });
  };
}

async function runToolStub(input: {
  readonly ctx: ToolContext;
  readonly set: string;
  readonly toolInput: unknown;
}): Promise<unknown> {
  const { ctx, set } = input;
  const stubs = await loadSessionToolStubSet(set);
  const stub = Object.hasOwn(stubs.tools, ctx.toolName) ? stubs.tools[ctx.toolName] : undefined;
  if (stub === undefined) {
    throw new TurnFailingToolError(
      "TOOL_STUB_MISSING",
      `Tool stub set "${set}" has no stub for "${ctx.toolName}", so the turn failed without ` +
        `running the real tool. Add "${ctx.toolName}" to \`tools\` in evals/stubs/${set}.ts.`,
    );
  }
  const state = resolveStubState(ctx.session.parent?.rootSessionId ?? ctx.session.id, stubs);
  return await stub(input.toolInput, { ...ctx, state });
}

async function loadSessionToolStubSet(set: string): Promise<ToolStubs> {
  const directory = resolveEveEvaluationToolStubsDirectory();
  if (directory === undefined) {
    throw new TurnFailingToolError(
      "TOOL_STUBS_UNAVAILABLE",
      `This session uses tool stub set "${set}", but this server was not started by \`eve eval\`, ` +
        "so it cannot load stubs. The turn failed without running the real tool.",
    );
  }
  const sets = await loadToolStubSetsModule();
  return await sets.loadToolStubSet(directory, set);
}

function loadToolStubSetsModule(): Promise<ToolStubSetsModule> {
  // Imported by path so hosted bundles never include the authored-module bundler.
  return import(
    pathToFileURL(resolvePackageSourceFilePath("src/evals/tool-stub-sets.ts")).href
  ) as Promise<ToolStubSetsModule>;
}

const STUB_STATES_GLOBAL_KEY = Symbol.for("eve.evalToolStubStates");

type StubStatesGlobal = typeof globalThis & {
  [STUB_STATES_GLOBAL_KEY]?: Map<string, unknown>;
};

/**
 * One state per root session, shared by its subagents. It lives in the eval
 * server's memory: it survives approval pauses and later turns, a retried step
 * can apply a stub's write twice, and a server restart loses it.
 */
function resolveStubState(rootSession: string, stubs: ToolStubs): unknown {
  const holder = globalThis as StubStatesGlobal;
  const states = (holder[STUB_STATES_GLOBAL_KEY] ??= new Map());
  if (!states.has(rootSession)) states.set(rootSession, stubs.state?.() ?? {});
  return states.get(rootSession);
}
