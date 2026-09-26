import {
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import {
  relaySessionEvents,
  type PublishedSessionEvents,
  type SessionEventTarget,
} from "#execution/publish-session-events.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import { getProxyInputRequests, retireProxyInputRequests } from "#harness/proxy-input-requests.js";
import { createInputResolvedEvent } from "#protocol/message.js";

/**
 * Retires a question its run withdrew and relays it `cancelled`, so channels
 * stop offering it. A question already answered has no route left to retire.
 */
export async function withdrawWorkflowToolRunQuestionStep(
  input: SessionEventTarget & {
    readonly requestId: string;
    readonly runId: string;
  },
): Promise<PublishedSessionEvents> {
  "use step";

  const session = readDurableSession(input.sessionState);
  const route = getProxyInputRequests(session.state).get(input.requestId);
  if (route?.answerHook?.runId !== input.runId) {
    return { serializedContext: input.serializedContext, sessionState: input.sessionState };
  }

  // A blocking run starts from the pending coordination batch, which carries
  // the coordinates of its request.
  const requested = getPendingCoordinationBatch(session.state)?.event;
  const retired = retireProxyInputRequests(session, [input.requestId]);
  return await relaySessionEvents(
    {
      serializedContext: input.serializedContext,
      sessionState: replaceDurableSessionSnapshot({ session: retired, state: input.sessionState }),
      sessionWritable: input.sessionWritable,
    },
    requested === undefined
      ? []
      : [
          createInputResolvedEvent({
            resolutions: [{ kind: "question", outcome: "cancelled", requestId: input.requestId }],
            ...requested,
          }),
        ],
  );
}
