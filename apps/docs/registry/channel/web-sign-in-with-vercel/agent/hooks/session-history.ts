import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { productionSessionStore, usesLocalSessions } from "../../lib/production-session-store.ts";

async function record(event: HookEvent, ctx: HookContext) {
  if (usesLocalSessions() || ctx.session.parent || ctx.channel.kind !== "eve") return;
  const ownerKey = ctx.session.auth.initiator?.attributes.webSessionOwner;
  if (typeof ownerKey !== "string") return;
  const at = event.meta.at;
  const title =
    event.type === "message.received"
      ? event.data.message.trim().replace(/\s+/g, " ").slice(0, 160)
      : undefined;
  await productionSessionStore().record({
    id: ctx.session.id,
    ownerKey,
    createdAt: at,
    title: title || "New chat",
    titleAt: title ? at : undefined,
    lastMessageAt: ["message.received", "message.completed"].includes(event.type) ? at : undefined,
    lastTurnAt: event.type === "turn.started" ? at : undefined,
  });
}
export default defineHook({
  events: {
    "session.started": record,
    "message.received": record,
    "message.completed": record,
    "turn.started": record,
  },
});
