import { contextStorage } from "#context/container.js";
import { SessionKey, ToolStubsKey } from "#context/keys.js";
import { ToolStubPlaybackKey, type ToolStubPlayback } from "#context/providers/tool-stubs-key.js";
import type { StubResult } from "#tool-stubs/types.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { isAsyncIterable } from "#shared/async-iterable.js";

/** An override changes only the executor; validation and approvals precede this boundary. */
export function executeWithToolStub(
  tool: string,
  input: unknown,
  options: ToolExecuteOptions,
  execute: () => unknown,
): unknown {
  const context = contextStorage.getStore();
  const scope = context?.get(ToolStubsKey);
  if (scope === undefined || !scope.rules.some((rule) => rule.tool === tool)) return execute();
  const session = context!.require(SessionKey);
  const callId = `${session.sessionId}:${session.turn.id}:${options.toolCallId}`;
  return executeStubbedTool(
    context!.require(ToolStubPlaybackKey),
    { callId, input, tool },
    options,
    execute,
  );
}

async function* executeStubbedTool(
  playback: ToolStubPlayback,
  call: { readonly callId: string; readonly input: unknown; readonly tool: string },
  options: ToolExecuteOptions,
  execute: () => unknown,
): AsyncIterable<unknown> {
  options.abortSignal?.throwIfAborted();
  const result = await playback.call(call);
  if (result.kind === "error") throw new Error(result.error);
  if (result.kind === "stub") {
    yield result.response;
    return;
  }
  const output = await execute();
  if (isAsyncIterable(output)) yield* output;
  else yield output;
}

/** Connection operations already run behind their nested validation and approval boundary. */
export async function connectionToolStub(
  tool: string,
  input: unknown,
  callId: string,
): Promise<StubResult> {
  const context = contextStorage.getStore();
  const scope = context?.get(ToolStubsKey);
  if (scope === undefined || !scope.rules.some((rule) => rule.tool === tool))
    return { kind: "real" };
  const session = context!.require(SessionKey);
  return await context!.require(ToolStubPlaybackKey).call({
    tool,
    input,
    callId: `${session.sessionId}:${session.turn.id}:${callId}`,
  });
}

/** Keep output-adapter failures fatal to the eval even if the model recovers. */
export async function recordToolStubFailure(
  tool: string,
  callId: string | undefined,
): Promise<void> {
  const context = contextStorage.getStore();
  const scope = context?.get(ToolStubsKey);
  if (scope === undefined || callId === undefined) return;
  const session = context!.require(SessionKey);
  await context!
    .require(ToolStubPlaybackKey)
    .fail(
      `${session.sessionId}:${session.turn.id}:${callId}`,
      `Stubbed tool "${tool}" failed during output processing.`,
    );
}
