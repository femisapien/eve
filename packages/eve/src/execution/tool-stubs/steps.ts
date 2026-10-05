import { getWritable } from "#compiled/@workflow/core/index.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";
import type { StubRequest } from "#execution/tool-stubs/playback.js";
import {
  STUB_FAILURE_NAMESPACE,
  stubResponseNamespace,
  type StubCall,
  type StubResult,
  type StubScope,
} from "#tool-stubs/types.js";

export async function publishStubResultStep(input: {
  readonly callId: string;
  readonly firstFailure: boolean;
  readonly result: StubResult;
}): Promise<void> {
  "use step";
  // Record failure before exposing the result, so an eval cannot finish first.
  if (input.firstFailure && input.result.kind === "error") {
    const failure = getWritable<string>({ namespace: STUB_FAILURE_NAMESPACE }).getWriter();
    try {
      await failure.write(input.result.error);
    } finally {
      failure.releaseLock();
    }
  }
  const writer = getWritable<StubResult>({
    namespace: stubResponseNamespace(input.callId),
  }).getWriter();
  try {
    await writer.write(input.result);
  } finally {
    writer.releaseLock();
  }
}

/** Also called inside ordinary tool steps; Workflow bodies use its step boundary. */
export async function callToolStubStep(scope: StubScope, call: StubCall): Promise<StubResult> {
  "use step";
  return await requestStub(scope, { kind: "call", call });
}

export async function reportStubFailureStep(
  scope: StubScope,
  callId: string,
  error: string,
): Promise<void> {
  "use step";
  await requestStub(scope, { kind: "failure", callId, error });
}

async function requestStub(scope: StubScope, request: StubRequest): Promise<StubResult> {
  const root = scope.rootSessionId;
  if (root === undefined)
    throw new Error("Tool stub session is missing its durable playback owner.");
  const callId = request.kind === "call" ? request.call.callId : `${request.callId}:failure`;
  await resumeHook(scope.token, request);
  const reader = getRun(root)
    .getReadable<StubResult>({ namespace: stubResponseNamespace(callId) })
    .getReader();
  try {
    const { done, value } = await reader.read();
    if (done) throw new Error("Tool stub session ended without a response.");
    return value;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function readStubFailure(sessionId: string): Promise<string | undefined> {
  const stream = getRun(sessionId).getReadable<string>({ namespace: STUB_FAILURE_NAMESPACE });
  if ((await stream.getTailIndex()) < 0) {
    await stream.cancel();
    return undefined;
  }
  const reader = stream.getReader();
  try {
    return (await reader.read()).value;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
