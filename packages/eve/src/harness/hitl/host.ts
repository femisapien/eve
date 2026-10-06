import type { SessionStateMap } from "#harness/types.js";
import { createTurnWaitingEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { TokenUsage } from "#shared/token-usage.js";

import type { Command } from "./command.js";
import type { Input } from "./input.js";

export type Stateful = { readonly state?: SessionStateMap };

/** Whose exchange an event belongs to: the session's own, or one it relays for a child or run. */
export type EventOrigin = "own" | "relayed";

/** The events `commit` carries out itself, for every host. */
type CommittedEvent = "publish" | "waitTurn" | "cancelTurn" | "declineBudget";

/** The events a host carries out: those that need what only its phase has. */
export type HostEvent = Exclude<Command, { readonly type: CommittedEvent }>;

/**
 * When human input is committed: in the turn's step before its model call,
 * after it, or in the session steps around a parked turn.
 */
export type Phase = "pre-step" | "post-step" | "parked";

/**
 * Which host may commit each input. With `EVENT_PHASES`, this is the contract
 * between inputs, commands and hosts. These tables define host permissions,
 * not HITL machine states or transitions. Phase also distinguishes
 * cancellation during an active turn step from cancellation cleanup while
 * parked; that behavior is implemented in `cancel`, not in these tables.
 *
 * The tables exist for compile-time protection. They derive `InputOf<P>` and
 * `HostEventOf<P>`, so each host accepts only the inputs it is placed to see
 * and is handed only the commands it can carry out; committing anything else
 * fails typecheck. `assertPhase` is the runtime backstop for a cast or an
 * untyped caller.
 *
 * For example, a delivery from a child (`delivery.received`) can answer a
 * request it relayed, which forwards the answer to that child
 * (`forwardAnswer`). Only the parked host, in the session steps around the
 * turn, can reach the child, so the delivery is committed there and nowhere
 * else.
 *
 * Each kind of request opens in one phase and resolves in one: approvals,
 * response policies and authorizations open post-step and resolve pre-step; the
 * budget question opens and resolves pre-step; relayed requests open and
 * resolve parked. The calls a step made settle post-step. A cancel stops the
 * turn in whatever phase it is in; the relayed requests it withdraws are
 * withdrawn once the turn has stopped, parked.
 */
export const INPUT_PHASES = {
  "turn.waiting": ["pre-step", "post-step"],
  "approval.requested": ["post-step"],
  "authorization.required": ["post-step"],
  "actions.dispatched": ["post-step"],
  "budget.exceeded": ["pre-step"],
  "relayed.requested": ["parked"],
  "relayed.authorization": ["parked"],
  "input.answered": ["pre-step"],
  "message.received": ["pre-step"],
  "cancel.requested": ["pre-step", "post-step", "parked"],
  "authorization.completed": ["pre-step"],
  "actions.settled": ["post-step"],
  time: ["pre-step"],
  "budget.stopped": ["pre-step"],
  "run.ended": ["parked"],
  "delivery.received": ["parked"],
  "relayed.withdrawn": ["parked"],
  "context.cleared": ["pre-step"],
  "input.resumed": ["pre-step"],
  "cancel.replayed": ["pre-step"],
} as const satisfies { readonly [T in Input["type"]]: readonly Phase[] };

/**
 * Which host carries out each command: the other half of the contract above.
 * It derives `HostEventOf<P>`, the commands a host in phase `P` must handle,
 * so typecheck holds each host's `carry` to exactly those: `forwardAnswer`
 * and `withdrawQuestion` reach children and runs, so only the parked host
 * has them. The rules return commands untyped by phase, so `commit` checks
 * each with `assertPhase` before handing it over. A history append happens
 * in every phase.
 */
export const EVENT_PHASES = {
  appendHistory: ["pre-step", "post-step", "parked"],
  addNote: ["pre-step"],
  consumeMessage: ["pre-step", "parked"],
  resumeAuthorization: ["pre-step"],
  grantBudget: ["pre-step"],
  resumeInput: ["pre-step"],
  forwardAnswer: ["parked"],
  withdrawQuestion: ["parked"],
} as const satisfies { readonly [T in HostEvent["type"]]: readonly Phase[] };

type In<Table extends Readonly<Record<string, readonly Phase[]>>, P extends Phase> = {
  [T in keyof Table]: P extends Table[T][number] ? T : never;
}[keyof Table];

/** What may be committed in phase `P`. */
export type InputOf<P extends Phase> = Extract<
  Input,
  { readonly type: In<typeof INPUT_PHASES, P> }
>;

/** What a host in phase `P` carries out. */
export type HostEventOf<P extends Phase> = Extract<
  HostEvent,
  { readonly type: In<typeof EVENT_PHASES, P> }
>;

/**
 * Where human input is committed, in one phase. A host carries out what only
 * its phase can, such as appending to history, and reports nothing back.
 */
export interface HumanInputHost<S extends Stateful, P extends Phase> {
  readonly phase: P;
  publish(event: UnstampedMessageStreamEvent, origin: EventOrigin): Promise<void>;
  /** The step a `turn.waiting` reports at, and the session's usage. */
  waitingAt(session: S): {
    readonly sequence: number;
    readonly turnId: string;
    readonly usage?: TokenUsage;
  };
  /** Carries out `event`, and returns the session it leaves. */
  carry(event: HostEventOf<P>, session: S): Promise<S>;
}

/** How human input ended the turn: cancelled, or by a Stop at the budget question. */
export type Ending =
  /**
   * `closed: "own"`: a cancel in the turn's step, which closed and reported
   * the turn's own requests; the parked settle withdraws only relayed ones.
   */
  | { readonly kind: "cancelled"; readonly declined?: undefined; readonly closed?: "own" }
  | { readonly kind: "cancelled"; readonly declined: "budget"; readonly requestId: string };

export interface Committed<S> {
  readonly session: S;
  readonly ending?: Ending;
}

/**
 * Fails an input or command in a phase it doesn't belong to: the runtime
 * backstop for `INPUT_PHASES` and `EVENT_PHASES`. Types keep a host to its
 * phase; this keeps a cast, an untyped caller, or a command the rules return
 * to it too.
 */
export function assertPhase<Table extends Readonly<Record<string, readonly Phase[]>>>(
  table: Table,
  type: keyof Table & string,
  phase: Phase,
): void {
  if (!table[type]!.includes(phase)) {
    throw new Error(
      `Human input "${type}" can't be committed ${phase === "parked" ? "while the turn is parked" : phase}.`,
    );
  }
}

/**
 * Publishes `turn.waiting` at the step `host` waits at: the only place a turn
 * reports it waits on input.
 */
export async function publishWaiting<S extends Stateful, P extends Phase>(
  host: HumanInputHost<S, P>,
  session: S,
  origin: EventOrigin,
): Promise<void> {
  const at = host.waitingAt(session);
  await host.publish(
    createTurnWaitingEvent({
      on: "input",
      sequence: at.sequence,
      turnId: at.turnId,
      usage: at.usage,
    }),
    origin,
  );
}
