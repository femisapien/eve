import { afterEach, expect, it, vi } from "vitest";
import { Client } from "#client/client.js";

afterEach(() => vi.restoreAllMocks());

it("sends the same declarative rules over the session creation boundary", async () => {
  let sent: unknown;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_request, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ ok: true, sessionId: "session", status: "accepted" }, { status: 202 });
  });
  const client = new Client({ host: "https://agent.test" });
  await client.sessions.create({
    stubs: [
      {
        id: "milk",
        tool: "complete_task",
        match: { task_id: { const: "milk" } },
        responses: [{ success: true }, { success: false }],
      },
    ],
  });
  expect(sent).toEqual({
    stubs: [
      {
        id: "milk",
        tool: "complete_task",
        match: { task_id: { const: "milk" } },
        responses: [{ success: true }, { success: false }],
      },
    ],
  });
});
