import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "eve/client";
import { applySessionActivity, type SessionActivity } from "./session-history.ts";

// Retain timestamps and a durable cursor, never conversation contents.
const activityCache = new Map<
  string,
  { streamIndex: number; activity: SessionActivity; modifiedAt: number }
>();

export async function localActivityReader(appRoot: string) {
  const registry = JSON.parse(
    await readFile(join(appRoot, ".eve", "next-dev-server.json"), "utf8"),
  );
  const origin = new URL(registry.origin);
  if (
    origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
  ) {
    throw new Error("Expected a local eve development server.");
  }
  const client = new Client({ host: origin.origin });
  return async (id: string): Promise<SessionActivity> => {
    const key = `${appRoot}:${origin.origin}:${id}`;
    const cached = activityCache.get(key);
    const streamDirectory = join(
      appRoot,
      ".eve",
      ".workflow-data",
      "streams",
      "chunks",
      `${id.replace(/^wrun_/, "strm_")}_user`,
    );
    // Local stream chunks are append-only files. Unchanged directories need no replay.
    let modifiedAt: number;
    try {
      modifiedAt = (await stat(streamDirectory)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    if (cached?.modifiedAt === modifiedAt) return cached.activity;
    const session = client.sessions.attach(id, { streamIndex: cached?.streamIndex ?? 0 });
    let activity = cached?.activity ?? {};
    for await (const event of session.stream({
      follow: false,
      signal: AbortSignal.timeout(15_000),
    })) {
      activity = applySessionActivity(activity, event);
    }
    activityCache.delete(key);
    activityCache.set(key, { streamIndex: session.state.streamIndex, activity, modifiedAt });
    while (activityCache.size > 500) activityCache.delete(activityCache.keys().next().value!);
    return activity;
  };
}
