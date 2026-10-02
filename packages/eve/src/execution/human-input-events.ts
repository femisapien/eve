import type { ModelMessage } from "ai";

import {
  relaySessionEvents,
  type PublishedSessionEvents,
  type SessionStepState,
} from "#execution/publish-session-events.js";
import { ignoreGoneTarget } from "#execution/tasks/workflow-target.js";
import type { WorkflowToolRunControlMessage } from "#execution/tools/workflow/messages.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import type { HumanInputEvent } from "#harness/human-input/index.js";
import { getSessionUsage } from "#harness/turn-tag-state.js";
import type { HandleEventFn, HarnessSessionBase } from "#harness/types.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { createTurnWaitingEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";

/** How human input ended the turn, for the session workflow to carry out. */
export type HumanInputEnding =
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

/**
 * Applies what human input reported to a session step outside the harness:
 * a cancel, or a request a workflow run relays or withdraws. Each event has
 * one meaning here. Returns how the turn ended, when an event ended it, which
 * the session workflow carries out once the step commits, and the messages
 * history gains. `session` is the session the step publishes for, which a
 * held turn's `turn.waiting` reports on.
 */
export async function applyHumanInputEvents(
  emit: HandleEventFn,
  events: readonly HumanInputEvent[],
  session?: HarnessSessionBase,
): Promise<{ readonly ending?: HumanInputEnding; readonly history: readonly ModelMessage[] }> {
  let ending: HumanInputEnding | undefined;
  const history: ModelMessage[] = [];
  for (const event of events) {
    switch (event.type) {
      case "publish":
        await emit(event.event);
        continue;
      case "history.appended":
        history.push(event.message);
        continue;
      case "turn.cancelled":
        ending ??= { kind: "cancelled" };
        continue;
      case "turn.failed":
        ending ??= { code: event.code, kind: "failed", message: event.message };
        continue;
      case "turn.held": {
        if (session === undefined) throw new Error("A held turn needs the session it holds.");
        const turn = getHarnessEmissionState(session.state);
        await emit(
          createTurnWaitingEvent({
            on: "input",
            sequence: turn.sequence,
            turnId: turn.turnId,
            usage: getSessionUsage(session),
          }),
        );
        continue;
      }
      case "question.withdrawn": {
        const decision: WorkflowToolRunControlMessage = {
          kind: "withdrawn",
          requestId: event.requestId,
        };
        await ignoreGoneTarget(resumeHook(event.control, decision));
        continue;
      }
      case "note":
      case "message.answered":
      case "calls.approved":
      case "responder.check":
      case "answer.forwarded":
      case "budget.granted":
      case "budget.declined":
        throw new Error(`Human input event "${event.type}" is not implemented.`);
    }
  }
  return { ending, history };
}

/**
 * Publishes, as relayed, what human input reported for requests this session
 * relays: withdrawals once nobody can answer them, and a run's withdrawn
 * question. The step writes the state that goes with them.
 */
export async function relayHumanInputEvents(
  target: SessionStepState,
  events: readonly HumanInputEvent[],
): Promise<PublishedSessionEvents> {
  const published: UnstampedMessageStreamEvent[] = [];
  for (const event of events) {
    if (event.type === "publish") published.push(event.event);
    else if (event.type === "question.withdrawn") await applyHumanInputEvents(emitNothing, [event]);
    else throw new Error(`Human input event "${event.type}" is not a relayed withdrawal.`);
  }
  return await relaySessionEvents(target, published);
}

async function emitNothing(): Promise<void> {}

/** Splits a transition's events into those of exchanges the session relays and its own. */
export function partitionRelayed(events: readonly HumanInputEvent[]): {
  readonly own: readonly HumanInputEvent[];
  readonly relayed: readonly HumanInputEvent[];
} {
  const relayed = events.filter((event) => event.type === "publish" && event.relayed === true);
  return { own: events.filter((event) => !relayed.includes(event)), relayed };
}
