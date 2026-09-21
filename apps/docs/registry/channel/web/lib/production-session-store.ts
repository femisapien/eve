import { neon } from "@neondatabase/serverless";
import { createSessionStore, type SessionStore } from "./session-store.ts";

let store: SessionStore | undefined;
export function productionSessionStore(): SessionStore {
  if (store) return store;
  const url = process.env.SESSION_DATABASE_URL;
  const scope = process.env.SESSION_INDEX_SCOPE;
  if (!url || !scope) throw new Error("Session storage is not configured.");
  const sql = neon(url);
  store = createSessionStore(
    (text, values) =>
      sql.query(text, values, { fetchOptions: { signal: AbortSignal.timeout(10_000) } }),
    scope,
  );
  return store;
}
export function usesLocalSessions() {
  return (
    process.env.NODE_ENV === "development" &&
    !["production", "preview"].includes(process.env.VERCEL_ENV ?? "")
  );
}
