import { contextStorage, type ContextContainer } from "#context/container.js";
import { SessionProjectionKey } from "#context/keys.js";
import { turnPosition, type TurnPosition } from "#harness/session-machine/view.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import {
  foldSession,
  initialSessionProjection,
  type SessionProjection,
} from "#protocol/session-projection.js";

/**
 * Stands in for the publish sink in tests that drive the harness with their own `handleEvent`:
 * folds each event into the session projection, which survives the fresh context each step gets.
 */
export function createProjectionRecorder(initial = initialSessionProjection()) {
  let projection: SessionProjection = initial;
  return {
    /** Call from the harness's `handleEvent`. */
    record(event: UnstampedMessageStreamEvent): void {
      projection = foldSession(projection, event);
      contextStorage.getStore()?.set(SessionProjectionKey, projection);
    },
    /** Seeds a step's context with the projection so far. */
    enter(ctx: ContextContainer): ContextContainer {
      ctx.set(SessionProjectionKey, projection);
      return ctx;
    },
    get projection(): SessionProjection {
      return projection;
    },
    get position(): TurnPosition {
      return turnPosition(projection);
    },
  };
}
