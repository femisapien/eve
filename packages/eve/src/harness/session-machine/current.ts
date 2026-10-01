import { contextStorage } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import { SessionProjectionKey } from "#context/keys.js";
import { initialSessionProjection, type SessionProjection } from "#protocol/session-projection.js";

/** The projection as of the last event the current step published. Steps only. */
export function currentProjection(
  ctx: ContextReader | undefined = contextStorage.getStore(),
): SessionProjection {
  return ctx?.get(SessionProjectionKey) ?? initialSessionProjection();
}
