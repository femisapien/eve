import type { ContextContainer } from "#context/container.js";
import { ActivityObserverKey, ActivitySessionProjectionKey } from "#context/keys.js";
import { actionSettled, projectActivityEvents } from "#execution/activity-events.js";
import { deriveRootTurnActivityWorkId } from "#execution/activity-work-id.js";
import { submitActivity } from "#execution/submit-activity.js";
import type { ActivityEventV1, ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { isTaskControlTool } from "#protocol/task-tools.js";
import {
  callStatus,
  initialSessionProjection,
  isCallSettled,
  reduceSessionProjection,
  rootTurnOf,
  type SessionProjection,
} from "#protocol/session-projection.js";

/** Projects one of the session's own events into best-effort activity presentation. */
export async function observeSessionActivity(input: {
  readonly ctx: ContextContainer;
  readonly event: MessageStreamEvent;
  readonly sessionId: string;
}): Promise<void> {
  const observer = input.ctx.get(ActivityObserverKey);
  if (observer === undefined) return;
  const { events, projection } = advanceSessionActivity({
    event: input.event,
    previous: input.ctx.get(ActivitySessionProjectionKey) ?? initialSessionProjection(),
    sessionId: input.sessionId,
    workIdentity: observer.workIdentity,
  });
  input.ctx.set(ActivitySessionProjectionKey, projection);
  await submitActivity({ events, sink: observer.sink });
}

/**
 * Folds one of the session's own events into its projection and maps the event onto activity.
 * Returns the projection pruned to open work, which is all a later event can change.
 */
export function advanceSessionActivity(input: {
  readonly event: MessageStreamEvent;
  readonly previous: SessionProjection;
  readonly sessionId: string;
  readonly workIdentity?: ActivityWorkIdentityV1;
}): { readonly events: readonly ActivityEventV1[]; readonly projection: SessionProjection } {
  const projection = reduceSessionProjection(input.previous, input.event);
  return {
    events: projectSessionActivity({ ...input, projection }),
    projection: retainOpenWork(projection),
  };
}

interface SessionActivityInput {
  readonly event: MessageStreamEvent;
  /** The session projection before `event`. */
  readonly previous: SessionProjection;
  /** The session projection after `event`. */
  readonly projection: SessionProjection;
  readonly sessionId: string;
  readonly workIdentity?: ActivityWorkIdentityV1;
}

/**
 * Maps one event onto activity. The event's own facts start work, actions, and blockers; a call
 * settles when the shared projection's status for it settles, so activity and every client agree.
 */
function projectSessionActivity(input: SessionActivityInput): readonly ActivityEventV1[] {
  const { event, projection } = input;
  const work = workFor(input, subjectTurnId(input));
  if (work === undefined) return [];

  const events: ActivityEventV1[] = [];
  if (
    (work.kind === "root-turn" && event.type === "turn.started") ||
    (work.kind !== "root-turn" &&
      (event.type === "session.started" || event.type === "turn.started"))
  ) {
    events.push({
      eventId: `${work.id}:started`,
      kind: "work.started",
      startedAt: event.meta.at,
      work,
    });
  }
  events.push(
    ...projectActivityEvents({
      at: event.meta.at,
      authorizationId: eventAuthorizationId(input.event),
      event,
      eventId: event.meta.id,
      lineage: work,
    }),
    // Before the root settles, which would cancel whatever it still shows running.
    ...settledCalls(input),
  );
  const outcome = turnOutcome(event);
  // A turn that ends waiting on a person leaves its work open until it resumes. Delegated work
  // settles here too: an agent session's result reaches its caller's reply hook, not this stream.
  if (outcome !== undefined && !hasOpenBlockers(projection, work)) {
    events.push({
      eventId: `${work.id}:settled:${outcome}`,
      kind: "work.settled",
      outcome,
      settledAt: event.meta.at,
      workId: work.id,
    });
  }
  return events;
}

function settledCalls(input: SessionActivityInput): readonly ActivityEventV1[] {
  const events: ActivityEventV1[] = [];
  for (const call of Object.values(input.projection.calls)) {
    // Agent calls are activity work, which their results settle; task controls never show.
    if (call.kind === "subagent-call" || call.kind === "remote-agent-call") continue;
    if (call.toolName !== undefined && isTaskControlTool(call.toolName)) continue;
    const before = callStatus(input.previous, call.callId);
    if (before === undefined || isCallSettled(before)) continue;
    const after = callStatus(input.projection, call.callId);
    if (after === undefined || !isCallSettled(after)) continue;
    const work = workFor(input, call.turnId);
    if (work === undefined) continue;
    events.push(
      actionSettled(
        `action:${work.id}:${call.callId}`,
        after as Exclude<typeof after, "running" | "awaiting-input">,
        input.event.meta.at,
      ),
    );
  }
  return events;
}

/** The turn whose work an event belongs to: the turn that made the call or asked the request. */
function subjectTurnId(input: SessionActivityInput): string | undefined {
  const { event, previous, projection } = input;
  switch (event.type) {
    case "action.partial":
    case "action.result":
      return projection.calls[event.data.result.callId]?.turnId ?? event.data.turnId;
    case "approval.candidate":
    case "approval.settled":
      return projection.inputs[event.data.requestId]?.turnId ?? event.data.turnId;
    case "authorization.completed":
      return previous.authorizations[event.data.attemptId]?.turnId ?? event.data.turnId;
    default:
      return "data" in event && "turnId" in event.data && typeof event.data.turnId === "string"
        ? event.data.turnId
        : undefined;
  }
}

function eventAuthorizationId(event: MessageStreamEvent): string | undefined {
  return event.type === "authorization.required" || event.type === "authorization.completed"
    ? event.data.attemptId
    : undefined;
}

function workFor(
  input: SessionActivityInput,
  turnId: string | undefined,
): ActivityWorkIdentityV1 | undefined {
  if (input.workIdentity !== undefined) {
    return {
      ...input.workIdentity,
      sessionId: input.sessionId,
      turnId: turnId ?? input.workIdentity.turnId,
    };
  }
  if (turnId === undefined) return undefined;
  const rootTurnId = rootTurnOf(input.projection, turnId);
  return {
    id: deriveRootTurnActivityWorkId({ sessionId: input.sessionId, turnId: rootTurnId }),
    kind: "root-turn",
    rootSessionId: input.sessionId,
    rootTurnId,
    sessionId: input.sessionId,
    turnId,
  };
}

function turnOutcome(event: MessageStreamEvent): "completed" | "failed" | "cancelled" | undefined {
  switch (event.type) {
    case "turn.completed":
      return "completed";
    case "turn.failed":
      return "failed";
    case "turn.cancelled":
      return "cancelled";
    default:
      return undefined;
  }
}

/** Delegated work spans the whole agent session, so any of its open blockers holds it. */
function hasOpenBlockers(projection: SessionProjection, work: ActivityWorkIdentityV1): boolean {
  const inRoot = (turnId: string) =>
    work.kind !== "root-turn" || rootTurnOf(projection, turnId) === work.rootTurnId;
  return (
    Object.values(projection.inputs).some(
      (input) => input.status !== "settled" && inRoot(input.turnId),
    ) ||
    Object.values(projection.authorizations).some(
      (attempt) => attempt.status === "required" && inRoot(attempt.turnId),
    )
  );
}

/**
 * Drops what no later event of this session can change: settled calls of ended turns, settled
 * requests and sign-ins, and turns nothing open refers to. A turn that continues another keeps its
 * root, because a later turn can continue it in turn.
 */
function retainOpenWork(projection: SessionProjection): SessionProjection {
  const calls = retain(
    projection.calls,
    (call) =>
      call.turnId === projection.activeTurnId ||
      !isCallSettled(callStatus(projection, call.callId)),
  );
  const kept = Object.values(calls);
  const inputs = retain(
    projection.inputs,
    (input, requestId) =>
      input.status !== "settled" || kept.some((call) => call.requestId === requestId),
  );
  const authorizations = retain(
    projection.authorizations,
    (attempt) => attempt.status === "required",
  );
  const tasks = Object.fromEntries(
    Object.entries(projection.tasks).flatMap(([taskId, task]) => {
      const taskCalls = retain(
        task.calls,
        (call, callId) => call.status === "working" || calls[callId] !== undefined,
      );
      return Object.keys(taskCalls).length === 0 ? [] : [[taskId, { ...task, calls: taskCalls }]];
    }),
  );
  const turnIds = new Set<string | undefined>([
    projection.activeTurnId,
    ...kept.map((call) => call.turnId),
    ...Object.values(inputs).flatMap((input) => [input.turnId, input.resumeTurnId]),
    ...Object.values(authorizations).map((attempt) => attempt.turnId),
    ...Object.values(tasks).flatMap((task) => Object.values(task.calls).map((call) => call.turnId)),
  ]);
  const turns = retain(
    projection.turns,
    (turn, turnId) => turnIds.has(turnId) || turn.rootTurnId !== turnId,
  );
  return { ...projection, authorizations, calls, inputs, tasks, turns };
}

function retain<T>(
  record: Readonly<Record<string, T>>,
  keep: (value: T, key: string) => boolean,
): Readonly<Record<string, T>> {
  return Object.fromEntries(Object.entries(record).filter(([key, value]) => keep(value, key)));
}
