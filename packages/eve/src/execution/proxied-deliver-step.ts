import type { SessionInboxAddress } from "#execution/session-inbox/address.js";
import { hasDelegatedSessionContext } from "#execution/delegated-session-context.js";
import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import { coalesceDeliverPayloads } from "#execution/deliver-payloads.js";
import {
  type DurableSessionState,
  readDurableSession,
  replaceDurableSessionSnapshot,
} from "#execution/durable-session-store.js";
import { relaySessionEvents, type SessionEventTarget } from "#execution/publish-session-events.js";
import { routeDeliverPayload } from "#subagents/hitl-proxy.js";
import { resumeSessionInbox } from "#execution/session-inbox/resume.js";
import { sendWorkflowAskAnswers } from "#execution/tools/workflow/answer.js";
import { getPendingCoordinationBatch } from "#harness/coordination.js";
import type { WorkflowAskRoute } from "#harness/proxy-input-requests.js";
import { createInputResolvedEvent, type InputResolution } from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";
import { retireProxyInputRequests } from "#harness/proxy-input-requests.js";

export type RoutedDeliverResult =
  | {
      readonly kind: "cancel-turn";
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    }
  | {
      readonly kind: "continue";
      readonly remainder: DeliverHookPayload | undefined;
      readonly serializedContext: Record<string, unknown>;
      readonly sessionState: DurableSessionState;
    };

interface ChildBucket {
  readonly workflowAsk?: WorkflowAskRoute;
  readonly childContinuationToken: string;
  readonly childSessionInbox?: SessionInboxAddress;
  readonly metadata: NonNullable<DeliverHookPayload["deliveryMetadata"]>[number][];
  readonly payloads: DeliverPayload[];
  readonly retireRequestIds: string[];
}

/**
 * Splits an envelope and forwards descendant input to the child that asked for
 * it. A `ctx.ask()` question is resolved by its workflow, not the harness, so
 * this session relays its `input.resolved` once the answer is on its way down.
 */
export async function routeProxiedDeliverStep(
  input: SessionEventTarget & { readonly delivery: DeliverHookPayload },
): Promise<RoutedDeliverResult> {
  "use step";
  let durableSession = readDurableSession(input.sessionState);
  const sourceDelivery = input.delivery;
  const parentPayloads = new Map<number, DeliverPayload>();
  const children = new Map<string, ChildBucket>();
  let parentAction: { readonly kind: "cancel-turn" } | undefined;
  // Only a person's own message may answer or skip a pending question.
  const resolveMessage =
    !hasDelegatedSessionContext(input.serializedContext) && sourceDelivery.caller === undefined;
  // Every payload routes against the same state, so a `ctx.ask()` question
  // resolved by an earlier payload is hidden from later ones; its run takes
  // one answer, and later messages must reach the parent instead.
  const resolvedQuestions = new Set<string>();

  for (const [sourcePayloadIndex, payload] of sourceDelivery.payloads.entries()) {
    const routed = routeDeliverPayload({
      allowRoute: (requestId) => !resolvedQuestions.has(requestId),
      payload,
      resolveMessage,
      state: durableSession.state,
    });
    parentAction ??= routed.parentAction;
    if (routed.forSelf !== undefined) parentPayloads.set(sourcePayloadIndex, routed.forSelf);

    for (const [childIndex, forChild] of routed.forChildren.entries()) {
      if (forChild.workflowAsk !== undefined) {
        for (const requestId of forChild.retireRequestIds) resolvedQuestions.add(requestId);
      }
      const key = [
        forChild.childContinuationToken,
        forChild.childSessionInbox?.sessionId ?? "",
      ].join("\0");
      const child = children.get(key) ?? {
        workflowAsk: forChild.workflowAsk,
        childContinuationToken: forChild.childContinuationToken,
        childSessionInbox: forChild.childSessionInbox,
        metadata: [],
        payloads: [],
        retireRequestIds: [],
      };
      const childPayloadIndex = child.payloads.length;
      child.payloads.push(forChild.payload);
      child.retireRequestIds.push(...forChild.retireRequestIds);
      if (routed.forSelf === undefined && childIndex === 0) {
        for (const metadata of sourceDelivery.deliveryMetadata ?? []) {
          if (metadata.payloadIndex === sourcePayloadIndex) {
            child.metadata.push({ ...metadata, payloadIndex: childPayloadIndex });
          }
        }
      }
      children.set(key, child);
    }
  }

  let retired = false;
  const answered: InputResolution[] = [];
  for (const child of children.values()) {
    if (child.workflowAsk !== undefined) {
      const responses = coalesceDeliverPayloads(child.payloads).inputResponses ?? [];
      await sendWorkflowAskAnswers(child.workflowAsk, responses);
      answered.push(...responses.map(toAnsweredResolution));
      durableSession = retireProxyInputRequests(durableSession, child.retireRequestIds);
      retired = true;
      continue;
    }

    const childDelivery: DeliverHookPayload = {
      ...sourceDelivery,
      deliveryMetadata: child.metadata.length === 0 ? undefined : child.metadata,
      payloads: child.payloads,
    };
    await resumeSessionInbox(
      child.childSessionInbox ?? child.childContinuationToken,
      childDelivery,
    );
    // Successfully forwarded request IDs are retired so later deliveries
    // cannot route through stale entries.
    durableSession = retireProxyInputRequests(durableSession, child.retireRequestIds);
    retired = true;
  }

  // A blocking run starts from the pending coordination batch, which carries
  // the coordinates of its request.
  const requested = getPendingCoordinationBatch(durableSession.state)?.event;
  const context = await relaySessionEvents(
    {
      serializedContext: input.serializedContext,
      sessionState: retired
        ? replaceDurableSessionSnapshot({ session: durableSession, state: input.sessionState })
        : input.sessionState,
      sessionWritable: input.sessionWritable,
    },
    requested === undefined || answered.length === 0
      ? []
      : [createInputResolvedEvent({ resolutions: answered, ...requested })],
  );
  if (parentAction !== undefined) return { ...context, ...parentAction };
  const orderedParentPayloads = [...parentPayloads].sort(([a], [b]) => a - b);
  const parentMetadata = orderedParentPayloads.flatMap(([sourcePayloadIndex], payloadIndex) =>
    (sourceDelivery.deliveryMetadata ?? [])
      .filter((metadata) => metadata.payloadIndex === sourcePayloadIndex)
      .map((metadata) => ({ ...metadata, payloadIndex })),
  );
  const remainder =
    orderedParentPayloads.length === 0
      ? undefined
      : {
          ...sourceDelivery,
          deliveryMetadata: parentMetadata.length === 0 ? undefined : parentMetadata,
          payloads: orderedParentPayloads.map(([, payload]) => payload),
        };
  return { ...context, kind: "continue", remainder };
}

function toAnsweredResolution(response: InputResponse): InputResolution {
  return { kind: "question", outcome: "answered", requestId: response.requestId, response };
}
