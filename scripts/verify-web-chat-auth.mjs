import assert from "node:assert/strict";

process.env.NODE_ENV = "development";
process.env.BETTER_AUTH_SECRET = "web-chat-verification-secret-do-not-use-in-production";
const { auth } = await import("../.web-preview-auth/lib/auth.ts");
const headers = new Headers({
  host: "localhost:4312",
  origin: "http://localhost:4312",
  cookie: "better-auth.session_data=forged",
  "x-user-id": "alice",
});
assert.equal(await auth.api.getSession({ headers }), null);
await assert.rejects(
  auth.api.updateUser({ headers, body: { vercelSubject: "victim" }, asResponse: true }),
  (error) => error.statusCode === 400 && /provider-managed/.test(error.body.message),
);
console.log("Forged session and client identity mutation rejected.");
