import { localActivityReader } from "@/lib/local-session-activity";
import { readLocalSessionHistory } from "@/lib/local-session-history";
import { paginateSessions, parseSessionPageQuery } from "@/lib/session-pagination";
import { productionSessionStore, usesLocalSessions } from "@/lib/production-session-store";
import { sessionViewer } from "@/lib/session-viewer";
import type { SessionHistory } from "@/lib/session-history";

export const runtime = "nodejs";
export async function GET(request: Request) {
  const headers = {
    "Cache-Control": "private, no-store",
    Vary: "Cookie",
  };
  let query;
  try {
    query = parseSessionPageQuery(new URL(request.url));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400, headers });
  }
  if (usesLocalSessions()) {
    try {
      const history: SessionHistory = {
        ...paginateSessions(
          await readLocalSessionHistory(process.cwd(), await localActivityReader(process.cwd())),
          query,
        ),
        viewer: { id: "local", name: "Local workspace", source: "local" },
      };
      return Response.json(history, { headers });
    } catch {
      return Response.json({ error: "Unable to read session history." }, { status: 503, headers });
    }
  }
  let viewer;
  try {
    viewer = await sessionViewer(request);
  } catch {
    return Response.json({ error: "Unable to verify your identity." }, { status: 401, headers });
  }
  if (!viewer)
    return Response.json({ error: "Sign in to view your chats." }, { status: 401, headers });
  try {
    const history: SessionHistory = {
      ...(await productionSessionStore().list(viewer.key, query)),
      viewer: { id: viewer.key, name: viewer.name, source: "user" },
    };
    return Response.json(history, { headers });
  } catch {
    return Response.json(
      { error: "Session history is unavailable. Please retry." },
      { status: 503, headers },
    );
  }
}
