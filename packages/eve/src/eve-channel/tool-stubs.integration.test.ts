import { describe, expect, it } from "vitest";
import { start } from "#internal/workflow/runtime.js";
import { eveChannel } from "#eve-channel/index.js";
import type { EveChannelInput } from "#eve-channel/types.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { buildSerializedContext } from "#internal/testing/entry-test-helpers.js";
import { mockAgentRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { attachRouteSessionCreator } from "#internal/nitro/routes/channel-route-context.js";
import { workflowEntry } from "#execution/session/entry.js";
import { STUB_OWNER_ATTRIBUTE } from "#tool-stubs/types.js";

const alice = {
  authenticator: "verified-token",
  issuer: "tests",
  principalId: "alice",
  principalType: "user",
  subject: "eval-a",
  attributes: { role: "eval" },
};
const bob = { ...alice, principalId: "bob", subject: "eval-b" };

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
      owner: invocationOwnerKey(alice),
      rules: [{ id: "auth", tool: "authenticate", response: true }],
    });
    expect(scope).toHaveProperty("token", expect.any(String));
  });

  it("denies another eval principal every stubbed-session entry point", async () => {
    const runtime = await createTestRuntime();
    await runtime.run(async () => {
      const run = await start(
        workflowEntry,
        [
          {
            kind: "initial",
            ownerDeploymentId: "dpl_inline",
            input: {},
            serializedContext: buildSerializedContext({ channelKind: "http" }),
          },
        ],
        {
          allowReservedAttributes: true,
          attributes: { [STUB_OWNER_ATTRIBUTE]: invocationOwnerKey(alice) },
        },
      );
      try {
        for (const [method, suffix] of [
          ["POST", ""],
          ["POST", "/cancel"],
          ["POST", "/compact"],
          ["POST", "/clear"],
          ["POST", "/reset"],
          ["GET", "/stream"],
          ["GET", "/stubs"],
        ]) {
          const response = await request(
            { auth: () => bob, allowToolStubs: { subjects: ["eval-a", "eval-b"] } },
            method!,
            `/eve/v1/session/:sessionId${suffix}`,
            { sessionId: run.runId },
            { message: "Hello" },
          );
          expect(response.status, `${method} ${suffix}`).toBe(404);
        }
        const proxy = await request(
          { auth: () => bob, allowToolStubs: { subjects: ["eval-a", "eval-b"] } },
          "GET",
          "/eve/v1/session/:parentSessionId/subagents/:callId/:childSessionId/stream",
          { parentSessionId: run.runId, childSessionId: "child", callId: "call" },
        );
        expect(proxy.status).toBe(404);
        const revoked = await request(
          { auth: () => alice, allowToolStubs: { subjects: ["eval-b"] } },
          "POST",
          "/eve/v1/session/:sessionId",
          { sessionId: run.runId },
          { message: "Hello" },
        );
        expect(revoked.status).toBe(403);
      } finally {
        await run.cancel();
      }
    });
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
