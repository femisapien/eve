import type { ModelMessage } from "ai";

import type { HumanInputEvent } from "#harness/human-input/index.js";
import type { HandleEventFn } from "#harness/types.js";

/** How human input ended the turn, for the session workflow to carry out. */
export type HumanInputEnding =
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed"; readonly code: string; readonly message: string };

/**
 * Applies what human input reported to a session step outside the harness:
 * a cancel, or a request a workflow run relays. Each event has one meaning
 * here. Returns how the turn ended, when an event ended it, which the session
 * workflow carries out once the step commits, and the messages history gains.
 */
export async function applyHumanInputEvents(
  emit: HandleEventFn,
  events: readonly HumanInputEvent[],
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
      case "note":
      case "message.answered":
      case "calls.approved":
      case "responder.check":
      case "answer.forwarded":
      case "budget.granted":
        throw new Error(`Human input event "${event.type}" is not implemented.`);
    }
  }
  return { ending, history };
}

/**
 * The session fails with the code human input gave. Thrown from the session
 * workflow, not a step, so it is not retried; the session reports it as its
 * terminal `session.failed`.
 */
export class HumanInputFailure extends Error {
  constructor(ending: Extract<HumanInputEnding, { readonly kind: "failed" }>) {
    super(ending.message);
    this.name = ending.code;
  }
}
