import { canReadSubagent } from "./subagent-access.ts";
import type { Channel } from "eve/channels";
import type { SessionOwner, SessionStore } from "./session-store.ts";

/** Protect every ID-addressed route, including nested streams and controls. */
export function withSessionAccess<T extends Channel>(
  channel: T,
  dependencies: {
    viewer: (request: Request) => Promise<SessionOwner | null>;
    store: () => SessionStore;
  },
): T {
  return {
    ...channel,
    routes: channel.routes.map((route) => {
      if (
        route.transport === "websocket" ||
        !(route.path.startsWith("/eve/v1/session") || route.path === "/eve/v1/info")
      )
        return route;
      return {
        ...route,
        handler: async (request, args) => {
          let owner: SessionOwner | null;
          try {
            owner = await dependencies.viewer(request);
          } catch {
            return Response.json({ error: "Unable to verify your identity." }, { status: 401 });
          }
          if (!owner) return route.handler(request, args);
          try {
            const id = args.params.sessionId ?? args.params.parentSessionId;
            if (
              id &&
              !(await dependencies.store().owns(owner.key, id)) &&
              !(
                route.method === "GET" &&
                route.path === "/eve/v1/session/:sessionId/stream" &&
                (await canReadSubagent(request, args, owner.key, dependencies.store()))
              )
            ) {
              return Response.json({ error: "Session not found." }, { status: 404 });
            }
            if (
              !["GET", "HEAD"].includes(request.method) &&
              (request.headers.get("sec-fetch-site") === "cross-site" ||
                (request.headers.has("origin") &&
                  request.headers.get("origin") !== new URL(request.url).origin))
            ) {
              return Response.json(
                { error: "Cross-origin session mutation is not allowed." },
                { status: 403 },
              );
            }
            const isCreate = route.method === "POST" && route.path === "/eve/v1/session";
            const createdAt = new Date().toISOString();
            const response = await route.handler(request, args);
            if ((isCreate || route.path.endsWith("/reset")) && response.ok) {
              const body = await response.clone().json();
              if (typeof body.sessionId !== "string") {
                if (isCreate) throw new Error("Missing session ID.");
                return response;
              }
              // Commit ownership before the browser can start its first stream.
              await dependencies.store().record({
                id: body.sessionId,
                ownerKey: owner.key,
                title: "New chat",
                createdAt,
              });
            }
            return response;
          } catch {
            return Response.json(
              { error: "Session storage is unavailable. Please retry." },
              { status: 503, headers: { "Cache-Control": "no-store" } },
            );
          }
        },
      };
    }),
  };
}
