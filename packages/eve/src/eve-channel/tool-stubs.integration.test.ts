import { describe, expect, it } from "vitest";
import { eveChannel } from "#eve-channel/index.js";
import type { EveChannelInput } from "#eve-channel/types.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { attachRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";

const alice = {
  authenticator: "verified-token",
  issuer: "tests",
  principalId: "alice",
  principalType: "user",
  subject: "eval-a",
  attributes: { role: "eval" },
};
const bob = { ...alice, principalId: "bob", subject: "eval-b", attributes: { role: "user" } };

describe("tool stub authorization", () => {
  it("rejects authenticated callers without explicit override permission before session creation", async () => {
    const response = await request(
      { auth: () => alice },
      "POST",
      "/eve/v1/session",
      {},
      { stubs: [{ id: "auth", tool: "authenticate", response: true }] },
    );
    expect(response.status).toBe(403);
  });

  it.each([
    { name: "first subject", subjects: ["eval-a", "eval-b"], subject: "eval-a", status: 202 },
    { name: "second subject", subjects: ["eval-a", "eval-b"], subject: "eval-b", status: 202 },
    {
      name: "wildcard environment",
      subjects: ["owner:acme:project:eval-runner:environment:*"],
      subject: "owner:acme:project:eval-runner:environment:preview",
      status: 202,
    },
    {
      name: "authenticated project outside the allowlist",
      subjects: ["owner:acme:project:eval-runner:environment:*"],
      subject: "owner:acme:project:production-agent:environment:production",
      status: 403,
    },
    { name: "empty allowlist", subjects: [], subject: "eval-a", status: 403 },
    { name: "missing subject", subjects: ["*"], subject: undefined, status: 403 },
  ])("enforces the subject policy for $name", async ({ subjects, subject, status }) => {
    const response = await request(
      { auth: () => ({ ...alice, subject }), allowToolStubs: { subjects } },
      "POST",
      "/eve/v1/session",
      {},
      { stubs: [{ id: "auth", tool: "authenticate", response: true }] },
      () => ({ sessionId: "created" }) as never,
    );
    expect(response.status).toBe(status);
  });

  it("binds the grant to route authentication before onMessage projects the session principal", async () => {
    let scope: unknown;
    const response = await request(
      {
        auth: () => alice,
        allowToolStubs: async (auth) => auth.attributes.role === "eval",
        onMessage: () => ({ auth: bob }),
      },
      "POST",
      "/eve/v1/session",
      {},
      { message: "Hello", stubs: [{ id: "auth", tool: "authenticate", response: true }] },
      (input) => {
        scope = input.toolStubs;
        return { sessionId: "created" } as never;
      },
    );
    expect(response.status).toBe(202);
    expect(scope).toMatchObject({
      rules: [{ id: "auth", tool: "authenticate", response: true }],
    });
    expect(scope).toHaveProperty("token", expect.any(String));
  });

  it.each([
    ["POST", "/eve/v1/session"],
    ["POST", "/eve/v1/session/:sessionId"],
    ["POST", "/eve/v1/session/:sessionId/cancel"],
    ["POST", "/eve/v1/session/:sessionId/compact"],
    ["POST", "/eve/v1/session/:sessionId/clear"],
    ["POST", "/eve/v1/session/:sessionId/reset"],
    ["GET", "/eve/v1/session/:sessionId/stream"],
    ["GET", "/eve/v1/session/:sessionId/stubs"],
    ["GET", "/eve/v1/session/:parentSessionId/subagents/:callId/:childSessionId/stream"],
  ])("requires channel authentication for %s %s", async (method, path) => {
    const response = await request(
      { auth: () => null, allowToolStubs: () => true },
      method,
      path,
      { sessionId: "session", parentSessionId: "parent", childSessionId: "child", callId: "call" },
      { message: "Hello" },
    );
    expect(response.status).toBe(401);
  });
});

async function request(
  config: EveChannelInput,
  method: string,
  path: string,
  params: Record<string, string>,
  body?: unknown,
  create?: Parameters<typeof attachRouteSessionCreator>[1],
): Promise<Response> {
  const route = eveChannel(config).routes!.find(
    (route) => route.method === method && route.path === path,
  )!;
  const args = {
    ...mockAgentRouteArgs(),
    ...mockChannelContext(() => {
      throw new Error("Unexpected channel dispatch.");
    }),
    params,
    waitUntil: () => undefined,
    requestIp: "127.0.0.1",
    attachSession: () => {
      throw new Error("Unauthorized session access reached the runtime.");
    },
    to: () => {
      throw new Error("Unexpected remote dispatch.");
    },
  } satisfies RouteHandlerArgs;
  if (create !== undefined) attachRouteSessionCreator(args, create);
  return (await route.handler(
    new Request("https://agent.test" + path, {
      method,
      ...(method === "GET"
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    }),
    args,
  )) as Response;
}
