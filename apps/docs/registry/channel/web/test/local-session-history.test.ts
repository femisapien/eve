import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readLocalSessionHistory, sessionFromLocalRun } from "../lib/local-session-history.ts";

const session = {
  runId: "wrun_ABC123",
  createdAt: "2026-09-19T20:00:00.000Z",
  attributes: { "$eve.type": "session", "$eve.title": "A conversation" },
};

test("history excludes child sessions, turns, and malformed run records", () => {
  assert.equal(sessionFromLocalRun({ ...session, attributes: { "$eve.type": "turn" } }), undefined);
  assert.equal(
    sessionFromLocalRun({
      ...session,
      attributes: { ...session.attributes, $parentRunId: "wrun_PARENT" },
    }),
    undefined,
  );
  assert.equal(sessionFromLocalRun({ ...session, runId: "../other" }), undefined);
  assert.equal(sessionFromLocalRun({ ...session, createdAt: "not a date" }), undefined);
  assert.equal(sessionFromLocalRun(null), undefined);
  assert.deepEqual(sessionFromLocalRun(session), {
    id: session.runId,
    title: "A conversation",
    createdAt: session.createdAt,
  });
});

test("reads the active local store, orders sessions, and tolerates unfinished JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "e0-history-"));
  try {
    assert.deepEqual(await readLocalSessionHistory(root), []);
    const directory = join(root, ".eve", ".workflow-data", "runs");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "one.json"), JSON.stringify(session));
    await writeFile(
      join(directory, "two.json"),
      JSON.stringify({ ...session, runId: "wrun_NEW", createdAt: "2026-09-20T20:00:00.000Z" }),
    );
    await writeFile(join(directory, "writing.json"), "{");
    await writeFile(
      join(directory, "turn.json"),
      JSON.stringify({ ...session, attributes: { "$eve.type": "turn" } }),
    );
    const result = await readLocalSessionHistory(root, async (id) =>
      id === session.runId
        ? { lastMessageAt: "2026-09-21T20:00:00.000Z", lastTurnAt: "2026-09-21T19:59:00.000Z" }
        : {},
    );
    assert.deepEqual(
      result.map((item) => item.id),
      ["wrun_ABC123", "wrun_NEW"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
