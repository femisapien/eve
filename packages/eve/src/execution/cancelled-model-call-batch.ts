import { contextStorage, type ContextContainer } from "#context/container.js";
import { SandboxKey, TurnDeliveryIdsKey } from "#context/keys.js";
import { preserveSerializedSessionDynamicModelSelection } from "#context/serialized-dynamic-model-selection.js";
import { serializeContext } from "#context/serialize.js";
import { preserveCancelledTurnMessage } from "#execution/cancelled-turn-message.js";
import { createDurableSessionValues } from "#execution/durable-session-store.js";
import type { DurableStepResult } from "#execution/session/turn-step-types.js";
import type { HarnessSession, StepInput, StepResult } from "#harness/types.js";
import { preserveSerializedInstrumentationState } from "#instrumentation/state.js";
import { preserveSerializedAgentTraceState } from "#tracing/agent-trace-context-store.js";
import { createLogger } from "#internal/logging.js";
import { BashJobsKey } from "#execution/sandbox/bash-jobs.js";

const log = createLogger("execution.cancelled-model-call-batch");

export interface CompletedModelCallCheckpoint {
  readonly result: StepResult;
  readonly serializedContext: Record<string, unknown>;
}

/** Builds the successful step result that commits a cancelled batch's completed model calls. */
export async function createCancelledModelCallBatchResult(input: {
  readonly beforeBatchContext: Record<string, unknown>;
  readonly checkpoint: CompletedModelCallCheckpoint | undefined;
  readonly ctx: ContextContainer;
  readonly initialSession: HarnessSession;
  readonly stepInput: StepInput | undefined;
}): Promise<DurableStepResult> {
  const interruptedContext = serializeContext(input.ctx);
  const previousSession = input.checkpoint?.result.session ?? input.initialSession;
  const jobs = input.ctx.get(BashJobsKey) ?? [];
  // Jobs from the discarded call still belong to the sandbox it opened.
  let sandboxState: HarnessSession["sandboxState"];
  let serializedJobs = interruptedContext[BashJobsKey.name];
  if (jobs.length > 0) {
    try {
      sandboxState = await input.ctx.get(SandboxKey)?.captureState();
    } catch (error) {
      // Without the owning sandbox, discarded jobs cannot safely survive rollback.
      serializedJobs = (input.checkpoint?.serializedContext ?? input.beforeBatchContext)[
        BashJobsKey.name
      ];
      log.warn("Could not checkpoint cancelled sandbox jobs; inspect and stop them explicitly.", {
        error,
        sessionId: previousSession.sessionId,
        jobs: jobs.map(({ pid, outputDirectory }) => ({ pid, outputDirectory })),
      });
    }
  }
  const checkpointSession =
    sandboxState === undefined ? previousSession : { ...previousSession, sandboxState };
  const cancelledSession =
    input.checkpoint === undefined
      ? await contextStorage.run(input.ctx, () =>
          preserveCancelledTurnMessage(checkpointSession, input.stepInput),
        )
      : checkpointSession;
  const checkpointContext = {
    ...(input.checkpoint?.serializedContext ?? input.beforeBatchContext),
    [TurnDeliveryIdsKey.name]: interruptedContext[TurnDeliveryIdsKey.name],
    [BashJobsKey.name]: serializedJobs,
  };

  return {
    action: "cancelled",
    serializedContext: preserveSerializedInstrumentationState(
      preserveSerializedAgentTraceState(
        preserveSerializedSessionDynamicModelSelection(checkpointContext, interruptedContext),
        interruptedContext,
      ),
      interruptedContext,
    ),
    ...createDurableSessionValues(cancelledSession),
  };
}
