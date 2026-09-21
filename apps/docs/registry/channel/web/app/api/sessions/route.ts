import { localActivityReader } from "@/lib/local-session-activity";
import { readLocalSessionHistory } from "@/lib/local-session-history";
import { paginateSessions, parseSessionPageQuery } from "@/lib/session-pagination";
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
  if (
    process.env.NODE_ENV === "development" &&
    !["production", "preview"].includes(process.env.VERCEL_ENV ?? "")
  ) {
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
  return Response.json(
    { error: "Production session history requires an authenticated store." },
    { status: 401, headers },
  );
}
