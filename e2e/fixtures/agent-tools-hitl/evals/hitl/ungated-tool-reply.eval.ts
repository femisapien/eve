import { defineEval } from "eve/evals";

const MARKER = "draft-status-3494";
const READ_STATUS =
  `Alice is checking her draft. Call the read-status tool exactly once with marker "${MARKER}". ` +
  "After the tool returns, tell Alice the status and marker from its result.";

export default defineEval({
  description: "An ungated status tool completes and produces a reply without a pending approval.",
  tags: ["hitl", "user-message", "tool-result"],
  timeoutMs: 120_000,
  async test(t) {
    // Given a fresh session with no pending approval.
    // When the user asks to read the draft status.
    const session = await t.session();
    const live = await session.start(READ_STATUS);
    const received = await live.waitForEvent("message.received");
    const turn = await live.result();

    // Then the tool executes once and the completed reply includes its status and marker.
    turn.expectOk();
    turn.calledTool("read-status", { status: "completed", count: 1 });
    turn.event("turn.completed", { count: 1 });
    turn.messageIncludes(MARKER);
    turn.messageIncludes("ready");
    turn.eventOrder([
      { type: "message.received", data: { turnId: received.data.turnId }, count: 1 },
      {
        type: "action.result",
        data: {
          turnId: received.data.turnId,
          status: "completed",
          result: { toolName: "read-status" },
        },
        count: 1,
      },
      {
        type: "message.completed",
        data: {
          turnId: received.data.turnId,
          message: (text) =>
            typeof text === "string" && text.includes(MARKER) && text.includes("ready"),
        },
        count: 1,
      },
      { type: "turn.completed", data: { turnId: received.data.turnId }, count: 1 },
    ]);
  },
});
