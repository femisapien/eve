import type { ChatSession } from "./session-history.ts";
import { sessionCursor, type SessionPage, type SessionPageQuery } from "./session-pagination.ts";

export type SessionQuery = (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>;
export interface SessionOwner {
  readonly key: string;
  readonly name: string;
}
export interface SessionRecord extends ChatSession {
  readonly ownerKey: string;
  readonly titleAt?: string;
}

/** This index owns browser access and metadata. eve remains the transcript store. */
export function createSessionStore(query: SessionQuery, scope: string) {
  return {
    async owns(ownerKey: string, id: string) {
      const rows = await query(
        "SELECT 1 FROM web_sessions WHERE scope = $1 AND session_id = $2 AND owner_key = $3",
        [scope, id, ownerKey],
      );
      return rows.length === 1;
    },
    async record(session: SessionRecord) {
      const rows = await query(
        `INSERT INTO web_sessions AS s
        (scope, session_id, owner_key, title, title_at, created_at, last_message_at, last_turn_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (scope, session_id) DO UPDATE SET
          created_at = LEAST(s.created_at, EXCLUDED.created_at),
          title = CASE WHEN EXCLUDED.title_at IS NOT NULL AND (s.title_at IS NULL OR EXCLUDED.title_at < s.title_at) THEN EXCLUDED.title ELSE s.title END,
          title_at = LEAST(s.title_at, EXCLUDED.title_at),
          last_message_at = GREATEST(s.last_message_at, EXCLUDED.last_message_at),
          last_turn_at = GREATEST(s.last_turn_at, EXCLUDED.last_turn_at)
        WHERE s.owner_key = EXCLUDED.owner_key
        RETURNING session_id`,
        [
          scope,
          session.id,
          session.ownerKey,
          session.title,
          session.titleAt ?? null,
          session.createdAt,
          session.lastMessageAt ?? null,
          session.lastTurnAt ?? null,
        ],
      );
      if (rows.length !== 1) throw new Error("Session ownership conflict.");
    },
    async list(ownerKey: string, page: SessionPageQuery): Promise<SessionPage> {
      const rows = await query(
        `SELECT session_id, title, created_at, last_message_at, last_turn_at
        FROM web_sessions WHERE scope = $1 AND owner_key = $2
        AND ($3::timestamptz IS NULL OR COALESCE(last_message_at, created_at) < $3
          OR (COALESCE(last_message_at, created_at) = $3 AND session_id > $4 COLLATE "C"))
        ORDER BY COALESCE(last_message_at, created_at) DESC, session_id ASC LIMIT $5`,
        [scope, ownerKey, page.after?.at ?? null, page.after?.id ?? null, page.limit + 1],
      );
      const sessions = rows.slice(0, page.limit).map((row): ChatSession => ({
        id: String(row.session_id),
        title: String(row.title),
        createdAt: iso(row.created_at),
        ...(row.last_message_at ? { lastMessageAt: iso(row.last_message_at) } : {}),
        ...(row.last_turn_at ? { lastTurnAt: iso(row.last_turn_at) } : {}),
      }));
      return {
        sessions,
        ...(rows.length > page.limit ? { nextCursor: sessionCursor(sessions.at(-1)!) } : {}),
      };
    },
  };
}
function iso(value: unknown) {
  return new Date(value as string | Date).toISOString();
}
export type SessionStore = ReturnType<typeof createSessionStore>;
