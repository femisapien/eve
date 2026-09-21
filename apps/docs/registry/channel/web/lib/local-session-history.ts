import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sortSessions, type ChatSession, type SessionActivity } from "./session-history.ts";

export function sessionFromLocalRun(value: unknown): ChatSession | undefined {
  if (!value || typeof value !== "object") return;
  const run = value as Record<string, unknown>;
  const attributes = run.attributes as Record<string, unknown> | undefined;
  if (
    attributes?.["$eve.type"] !== "session" ||
    attributes["$parentRunId"] ||
    typeof run.runId !== "string" ||
    !/^wrun_[a-zA-Z0-9]+$/.test(run.runId)
  )
    return;
  const createdAt = run.createdAt;
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) return;
  const title = attributes["$eve.title"];
  return {
    id: run.runId,
    title: typeof title === "string" && title.trim() ? title.trim() : "New chat",
    createdAt,
  };
}

export async function readLocalSessionHistory(
  appRoot: string,
  readActivity: (id: string) => Promise<SessionActivity> = async () => ({}),
): Promise<ChatSession[]> {
  const directory = join(appRoot, ".eve", ".workflow-data", "runs");
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const sessions = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        try {
          return sessionFromLocalRun(JSON.parse(await readFile(join(directory, file), "utf8")));
        } catch (error) {
          // A run can be replaced or removed while the development server is writing it.
          if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
            return;
          throw error;
        }
      }),
  );
  const history = sessions.filter((session): session is ChatSession => session !== undefined);
  // Bound stream reads when opening a workspace with many conversations.
  const enriched: ChatSession[] = [];
  for (let index = 0; index < history.length; index += 4) {
    enriched.push(
      ...(await Promise.all(
        history.slice(index, index + 4).map(async (session) => ({
          ...session,
          ...(await readActivity(session.id)),
        })),
      )),
    );
  }
  return sortSessions(enriched);
}
