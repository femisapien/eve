import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationResult } from "#harness/authorization.js";
import type { StepInput } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputResponse } from "#shared/input.js";

import type { RelayRoute } from "./input.js";

/**
 * A command: what the host is told to do. Each has one meaning for the
 * runtime, which carries it out and decides nothing: publish an event, append
 * to history, hand a child or run its answer, or end the turn. None reports
 * anything back.
 */
export type Command =
  | {
      readonly type: "publish";
      readonly event: UnstampedMessageStreamEvent;
      /** It belongs to an exchange this session relays for a child or run: publish it as relayed. */
      readonly relayed?: true;
    }
  | { readonly type: "appendHistory"; readonly message: ModelMessage }
  /** The held step joined history: the turn reads the input that waited behind its calls. */
  | { readonly type: "resumeInput"; readonly input: StepInput }
  /** The message answered open requests, so the turn doesn't read it as input. */
  | { readonly type: "consumeMessage" }
  /**
   * An authorization completed: hand its callback to the tool call or policy that
   * asked, and run as `requester` when one is given.
   */
  | {
      readonly type: "resumeAuthorization";
      readonly result: AuthorizationResult & { readonly name: string };
      readonly requester: SessionAuthContext | null;
    }
  /** Deliver these answers to the child session, remote agent, or run that asked. */
  | {
      readonly type: "forwardAnswer";
      readonly route: RelayRoute;
      readonly responses: readonly InputResponse[];
    }
  /** Tell a run, on its control hook, that its `ctx.ask()` question is withdrawn. */
  | { readonly type: "withdrawQuestion"; readonly control: string; readonly requestId: string }
  /**
   * The turn waits on a person: publish `turn.waiting`. A relayed request waits
   * on the call that asked, which keeps running.
   */
  | { readonly type: "waitTurn"; readonly relayed?: true }
  /** Grant a fresh budget window: the person chose to continue. */
  | { readonly type: "grantBudget" }
  /** The person chose to stop: the budget question is resolved; cancel the turn. */
  | { readonly type: "declineBudget"; readonly requestId: string }
  /** Tell the model something with the turn's next input. */
  | { readonly type: "addNote"; readonly text: string }
  /** End the turn as cancelled; `closed: "own"` when a cancel closed its own requests. */
  | { readonly type: "cancelTurn"; readonly closed?: "own" };

export type Next =
  | { readonly run: "model" }
  /** Run the held step's approved calls (`approvedCalls`), post-step. */
  | { readonly run: "approved" }
  | { readonly waiting: "input" };
