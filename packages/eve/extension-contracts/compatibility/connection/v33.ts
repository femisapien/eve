import { defineDynamic, defineMcpClientConnection } from "#public/connections/index.js";

// Epoch 33 sign-in events could omit `attemptId`, and action results had no
// `cancelled` status; both only add to what a reader receives.
export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) =>
      ctx.session.auth.current === null
        ? null
        : defineMcpClientConnection({
            description: "Search the support knowledge base.",
            url: "https://support.example.com/mcp",
          }),
  },
});
