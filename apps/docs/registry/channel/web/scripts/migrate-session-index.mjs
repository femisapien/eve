import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

if (!process.env.SESSION_DATABASE_URL)
  throw new Error("Set SESSION_DATABASE_URL before migrating.");
const sql = neon(process.env.SESSION_DATABASE_URL);
const schema = await readFile(new URL("../db/session-index.sql", import.meta.url), "utf8");
await sql.transaction(
  schema
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((statement) => sql.query(statement, [])),
);
console.log("Session index schema is ready.");
