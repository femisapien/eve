import { createHook } from "#compiled/@workflow/core/index.js";
import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import { StubPlayback } from "#tool-stubs/rules.js";
import { publishStubResultStep } from "#execution/tool-stubs/steps.js";
import { STUB_CONTEXT_KEY, type StubCall, type StubScope } from "#tool-stubs/types.js";

export type StubRequest =
  | { readonly kind: "call"; readonly call: StubCall }
  | { readonly kind: "failure"; readonly callId: string; readonly error: string };

/** The original workflow keeps this hook even while a successor owns its turns. */
export async function withStubPlayback<T>(
  context: Record<string, unknown>,
  sessionId: string,
  run: () => Promise<T>,
): Promise<T> {
  const scope = context[STUB_CONTEXT_KEY] as StubScope | undefined;
  if (scope === undefined || scope.rootSessionId !== undefined) return await run();
  context[STUB_CONTEXT_KEY] = { ...scope, rootSessionId: sessionId };
  const playback = new StubPlayback(scope.rules);
  const hook = createHook<StubRequest>({ token: scope.token });
  await claimHookOwnership(hook);
  let failed = false;
  const serve = async (): Promise<never> => {
    for await (const request of hook) {
      const result =
        request.kind === "failure"
          ? playback.fail(request.callId, request.error)
          : playback.call(request.call);
      const firstFailure = result.kind === "error" && !failed;
      failed ||= firstFailure;
      await publishStubResultStep({
        callId: request.kind === "call" ? request.call.callId : `${request.callId}:failure`,
        firstFailure,
        result,
      });
    }
    throw new Error("Tool stub playback ended before its session.");
  };
  try {
    return await Promise.race([run(), serve()]);
  } finally {
    await disposeHook(hook);
  }
}
