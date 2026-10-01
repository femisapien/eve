import { SessionProjectionKey } from "#context/keys.js";
import {
  initialSessionProjection,
  turnCoordinates,
  type SessionProjection,
} from "#protocol/session-projection.js";

// What the session machine reads. Lifecycle comes from the stored projection, which the publish
// sink folds from every event the session publishes; nothing else writes it. Workflow bodies
// import this module, so it stays free of runtime dependencies; a step reads the live projection
// through `current.ts`.

/** The projection a step saved, read from its serialized context without restoring it. */
export function storedProjection(serializedContext: Record<string, unknown>): SessionProjection {
  return (
    (serializedContext[SessionProjectionKey.name] as SessionProjection | undefined) ??
    initialSessionProjection()
  );
}

/** Coordinates the next lifecycle event carries, and whether a turn is open. */
export interface TurnPosition {
  readonly sessionStarted: boolean;
  readonly sequence: number;
  readonly stepIndex: number;
  /** The open turn's id, or `""` between turns. */
  readonly turnId: string;
  /** The open turn streamed assistant output, so steering can no longer restart it. */
  readonly assistantOutputStarted?: boolean;
}

export function turnPosition(projection: SessionProjection): TurnPosition {
  const { sequence, stepIndex } = turnCoordinates(projection);
  const turn =
    projection.activeTurnId === undefined ? undefined : projection.turns[projection.activeTurnId];
  const position: { -readonly [K in keyof TurnPosition]: TurnPosition[K] } = {
    sessionStarted: projection.started === true,
    sequence,
    stepIndex,
    turnId: turn?.turnId ?? "",
  };
  if (turn?.outputStarted === true) position.assistantOutputStarted = true;
  return position;
}

/** The open turn's id, or the id the next turn takes. */
export function activeTurnId(position: Pick<TurnPosition, "sequence" | "turnId">): string {
  return position.turnId === "" ? `turn_${position.sequence}` : position.turnId;
}

export function isBetweenTurns(projection: SessionProjection): boolean {
  return projection.activeTurnId === undefined;
}

/** The index the open turn's next `step.started` takes. */
export function nextStepIndex(projection: SessionProjection): number {
  const turn =
    projection.activeTurnId === undefined ? undefined : projection.turns[projection.activeTurnId];
  return turn?.stepStarted === true ? turn.stepIndex + 1 : 0;
}
