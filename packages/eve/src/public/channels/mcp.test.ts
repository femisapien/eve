import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import type { AgentDescription } from "#channel/agent-description.js";
import type { InvokeToolFn } from "#channel/invoke-tool.js";
import {
  attachAgentInfoRouteResponse,
  attachRouteChannelName,
  attachRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { MCP_PROTOCOL_VERSION } from "#internal/mcp/streamable-http-server.js";
import { ForbiddenError, none, oauthResource, withAuthChallenges } from "#public/channels/auth.js";
import { mcpChannel } from "#public/channels/mcp.js";
import { mockAgentDescriptionRouteArgs } from "#internal/testing/mocks/mock-route-args.js";
import { unusedInvokeTool } from "#internal/testing/unused-invoke-tool.js";

const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";

const principal: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

describe("mcpChannel", () => {
  it("fails closed when auth is omitted", () => {
    expect(() => mcpChannel({} as never)).toThrow(
      "mcpChannel requires auth. Use none() for explicit public access.",
    );
  });

  it("serves discovery and an empty tool list for an agent without tools", async () => {
    const channel = mcpChannel({ auth: none() });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /eve/v1/mcp",
      "POST /eve/v1/mcp",
      "DELETE /eve/v1/mcp",
    ]);
    const postRoute = channel.routes[1]!;
    if (postRoute.transport === "websocket") throw new Error("expected HTTP route");

    const initialize = await postRoute.handler(
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
          protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
        },
      }),
      routeArgs(),
    );
    const initialized = (await jsonRpcResponse(initialize)) as {
      result: { instructions?: string; serverInfo: { name: string } };
    };
    expect(initialized.result.serverInfo.name).toBe("compiled-agent");
    expect(initialized.result.instructions).toBeUndefined();

    const discovered = await postRoute.handler(
      mcpRequest(
        {
          id: "discover",
          jsonrpc: "2.0",
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
              "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
            },
          },
        },
        { "mcp-method": "server/discover", "mcp-protocol-version": MCP_PROTOCOL_VERSION },
      ),
      routeArgs(),
    );
    await expect(jsonRpcResponse(discovered)).resolves.toMatchObject({
      result: {
        _meta: { "io.modelcontextprotocol/serverInfo": { name: "compiled-agent" } },
        capabilities: {
          extensions: { "dev.eve/tool-sessions": {} },
          tools: { listChanged: true },
        },
      },
    });

    const tools = await postRoute.handler(
      mcpRequest({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
      routeArgs(),
    );
    await expect(jsonRpcResponse(tools)).resolves.toMatchObject({ result: { tools: [] } });
  });

  it("no longer serves the agent_* invocation tools", async () => {
    const createSession = vi.fn();
    const channel = mcpChannel({ auth: none() });
    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");

    const called = await route.handler(
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { message: "hello" }, name: "agent_start" },
      }),
      routeArgs(createSession),
    );
    const body = (await jsonRpcResponse(called)) as {
      error?: unknown;
      result?: { isError?: boolean };
    };
    expect(body.error ?? body.result?.isError).toBeTruthy();
    expect(createSession).not.toHaveBeenCalled();
  });

  it("uses existing eve auth strategies directly", async () => {
    const channel = mcpChannel({ auth: () => principal });
    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");

    const response = await route.handler(
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
          protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
        },
      }),
      routeArgs(),
    );
    expect(response.status).toBe(200);
  });

  it("rejects cross-origin requests before running auth", async () => {
    const authenticate = vi.fn(() => principal);
    const channel = mcpChannel({ auth: authenticate });
    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");

    const response = await route.handler(
      mcpRequest(
        {
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
        },
        { origin: "https://attacker.example" },
      ),
      routeArgs(),
    );

    expect(response.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("mounts OAuth resource metadata and augments auth failures", async () => {
    const channel = mcpChannel({
      auth: oauthResource(
        withAuthChallenges(
          () => null,
          [{ parameters: { realm: "eve" }, scheme: "Basic" }, { scheme: "Bearer" }],
        ),
        {
          issuer: "https://issuer.example",
          resource: "https://agent.example/delegate",
          scopes: ["agent:invoke"],
        },
      ),
      route: "/delegate",
    });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /.well-known/oauth-protected-resource/delegate",
      "HEAD /.well-known/oauth-protected-resource/delegate",
      "OPTIONS /.well-known/oauth-protected-resource/delegate",
      "GET /delegate",
      "POST /delegate",
      "DELETE /delegate",
    ]);

    const metadataRoute = channel.routes[0]!;
    if (metadataRoute.transport === "websocket") throw new Error("expected HTTP route");
    const metadata = await metadataRoute.handler(
      requestWithHost("https://private.example/.well-known/oauth-protected-resource/delegate"),
      {} as never,
    );
    await expect(metadata.json()).resolves.toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/delegate",
      scopes_supported: ["agent:invoke"],
    });
    expect(metadata.headers.get("access-control-allow-origin")).toBe("*");

    const route = channel.routes[4]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      requestWithHost("https://private.example/delegate", { method: "POST" }),
      {} as never,
    );
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain(
      'resource_metadata="https://agent.example/.well-known/oauth-protected-resource/delegate"',
    );
    expect(challenge).toContain('Basic realm="eve"');
    expect(challenge).toContain('scope="agent:invoke"');
    expect(challenge?.match(/\bBearer\b/g)).toHaveLength(1);
  });

  it("adds resource metadata only to explicit insufficient-scope responses", async () => {
    const genericChannel = mcpChannel({
      auth: oauthResource(
        () => {
          throw new ForbiddenError();
        },
        { issuer: "https://issuer.example", scopes: ["agent:invoke"] },
      ),
    });
    const genericRoute = genericChannel.routes[4]!;
    if (genericRoute.transport === "websocket") throw new Error("expected HTTP route");
    const generic = await genericRoute.handler(
      requestWithHost("https://agent.example/eve/v1/mcp", { method: "POST" }),
      {} as never,
    );
    expect(generic.status).toBe(403);
    expect(generic.headers.get("www-authenticate")).toBeNull();

    const scopedChannel = mcpChannel({
      auth: oauthResource(
        () => {
          throw new ForbiddenError({
            challenges: [
              {
                parameters: { error: "insufficient_scope", scope: "agent:admin" },
                scheme: "Bearer",
              },
            ],
          });
        },
        { issuer: "https://issuer.example", scopes: ["agent:invoke"] },
      ),
    });
    const scopedRoute = scopedChannel.routes[4]!;
    if (scopedRoute.transport === "websocket") throw new Error("expected HTTP route");
    const scoped = await scopedRoute.handler(
      requestWithHost("https://agent.example/eve/v1/mcp", { method: "POST" }),
      {} as never,
    );
    const scopedChallenge = scoped.headers.get("www-authenticate");
    expect(scoped.status).toBe(403);
    expect(scopedChallenge).toContain('error="insufficient_scope"');
    expect(scopedChallenge).toContain('scope="agent:admin"');
    expect(scopedChallenge).not.toContain('scope="agent:invoke"');
    expect(scopedChallenge).toContain(
      'resource_metadata="https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp"',
    );
    expect(scopedChallenge?.match(/\bBearer\b/g)).toHaveLength(1);
  });

  it("preserves invalid_token in the OAuth resource challenge", async () => {
    const channel = mcpChannel({
      auth: oauthResource(
        withAuthChallenges(() => null, [{ scheme: "Bearer" }]),
        {
          issuer: "https://issuer.example",
          scopes: ["agent:invoke"],
        },
      ),
    });
    const route = channel.routes[4]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      requestWithHost("https://agent.example/eve/v1/mcp", {
        headers: { authorization: "Bearer expired-token" },
        method: "POST",
      }),
      {} as never,
    );

    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain('scope="agent:invoke"');
    expect(challenge).toContain(
      'resource_metadata="https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp"',
    );
    expect(challenge?.match(/\bBearer\b/g)).toHaveLength(1);
  });

  it("derives the protected resource from the public request origin", async () => {
    const channel = mcpChannel({
      auth: oauthResource(() => null, { issuer: "https://issuer.example" }),
      route: "/delegate",
    });
    const route = channel.routes[0]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      requestWithHost("https://agent.example/.well-known/oauth-protected-resource/delegate"),
      {} as never,
    );
    await expect(response.json()).resolves.toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/delegate",
    });
  });

  it("allows overriding the protected-resource metadata path", () => {
    const channel = mcpChannel({
      auth: oauthResource(() => null, {
        issuer: "https://issuer.example",
        metadataPath: "/.well-known/custom-resource",
      }),
    });
    expect(channel.routes.slice(0, 3).map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /.well-known/custom-resource",
      "HEAD /.well-known/custom-resource",
      "OPTIONS /.well-known/custom-resource",
    ]);
  });

  it("serves protected-resource metadata to cross-origin browser clients", async () => {
    const channel = mcpChannel({
      auth: oauthResource(() => null, { issuer: "https://issuer.example" }),
    });
    const [getRoute, headRoute, optionsRoute] = channel.routes;
    if (
      getRoute?.transport === "websocket" ||
      headRoute?.transport === "websocket" ||
      optionsRoute?.transport === "websocket" ||
      getRoute === undefined ||
      headRoute === undefined ||
      optionsRoute === undefined
    ) {
      throw new Error("expected HTTP metadata routes");
    }

    const origin = "https://client.example";
    const get = await getRoute.handler(
      requestWithHost("https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp", {
        headers: { origin },
      }),
      {} as never,
    );
    expect(get.status).toBe(200);
    expect(get.headers.get("access-control-allow-origin")).toBe("*");

    const head = await headRoute.handler(
      requestWithHost("https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp", {
        headers: { origin },
        method: "HEAD",
      }),
      {} as never,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("access-control-allow-origin")).toBe("*");
    expect(head.headers.get("content-type")).toContain("application/json");
    expect(await head.text()).toBe("");

    const options = await optionsRoute.handler(
      requestWithHost("https://agent.example/.well-known/oauth-protected-resource/eve/v1/mcp", {
        headers: {
          "access-control-request-headers": "authorization, mcp-protocol-version",
          "access-control-request-method": "GET",
          origin,
        },
        method: "OPTIONS",
      }),
      {} as never,
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("*");
    expect(options.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    expect(options.headers.get("access-control-allow-headers")).toBe(
      "authorization, mcp-protocol-version",
    );
    expect(options.headers.get("vary")).toBe("Access-Control-Request-Headers");
  });
});

interface RouteArgsOverrides {
  readonly createSession?: () => Promise<never>;
  readonly description?: AgentDescription;
  readonly invokeTool?: InvokeToolFn;
}

function routeArgs(overrides: RouteArgsOverrides | (() => Promise<never>) = {}): RouteHandlerArgs {
  const options = typeof overrides === "function" ? { createSession: overrides } : overrides;
  const unavailable = () => {
    throw new Error("Route operation is unavailable in this test.");
  };
  const description = options.description ?? { name: "compiled-agent", skills: [], tools: [] };
  const args: RouteHandlerArgs = {
    ...mockAgentDescriptionRouteArgs(),
    attachSession: unavailable,
    describe: async () => description,
    from: unavailable,
    params: {},
    requestIp: "127.0.0.1",
    invokeTool: options.invokeTool ?? unusedInvokeTool,
    resolveSession: vi.fn(),
    to: unavailable,
    waitUntil: vi.fn(),
  };
  return attachRouteChannelName(
    attachAgentInfoRouteResponse(
      attachRouteSessionCreator(args, options.createSession ?? vi.fn()),
      async () =>
        Response.json({
          agent: {
            description: "Investigates tasks.",
            name: "compiled-agent",
          },
        }),
    ),
    "mcp",
  );
}

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://agent.example/mcp", {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "agent.example",
      ...headers,
    },
    method: "POST",
  });
}

function requestWithHost(url: string, init: RequestInit = {}): Request {
  const target = new URL(url);
  return new Request(url, {
    ...init,
    headers: { host: target.host, ...Object.fromEntries(new Headers(init.headers)) },
  });
}

async function jsonRpcResponse(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return await response.json();
  }
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("MCP SSE response did not contain a data event.");
  return JSON.parse(data.slice("data: ".length));
}

const SECRET = "x".repeat(32);
const CAPS_ALL = { elicitation: { form: {}, url: {} } };
/** {@link CAPS_ALL} plus the `dev.eve/tool-sessions` opt-in. */
const CAPS_SESSIONS = { ...CAPS_ALL, extensions: { "dev.eve/tool-sessions": {} } };

/** A call from a client that declared tool sessions, sending `key`. */
function keyedCall(key: unknown, call: ModernCall = {}): ModernCall {
  return {
    ...call,
    capabilities: CAPS_SESSIONS,
    meta: { ...call.meta, "dev.eve/tool-session": key },
  };
}

/** The payload of a minted requestState. The codec signs; it does not encrypt. */
function decodeState(state: unknown): Record<string, any> {
  if (typeof state !== "string") throw new Error("requestState was not a string.");
  const body = state.split(".")[1]!;
  return (JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { p: Record<string, any> })
    .p;
}

const toolsDescription: AgentDescription = {
  name: "compiled-agent",
  skills: [],
  tools: [
    {
      approval: true,
      description: "Deploys.",
      inputSchema: { properties: { env: { type: "string" } }, type: "object" },
      invocable: true,
      name: "deploy",
    },
    {
      approval: false,
      description: "Runs only in a turn.",
      inputSchema: { type: "object" },
      invocable: false,
      name: "harness_only",
    },
    {
      approval: false,
      description: "Reads issues.",
      inputSchema: { type: "object" },
      invocable: true,
      name: "issues",
    },
    {
      approval: false,
      description: "Echoes.",
      inputSchema: {
        additionalProperties: false,
        properties: { x: { type: "number" } },
        type: "object",
      },
      invocable: true,
      name: "plain",
      outputSchema: { properties: { x: { type: "number" } }, type: "object" },
    },
  ],
};

interface ModernCall {
  readonly capabilities?: Readonly<Record<string, unknown>>;
  readonly headers?: Record<string, string>;
  readonly meta?: Readonly<Record<string, unknown>>;
}

function modernRequest(
  method: string,
  params: Readonly<Record<string, unknown>> = {},
  call: ModernCall = {},
): Request {
  const headers: Record<string, string> = {
    "mcp-method": method,
    "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    ...call.headers,
  };
  if (typeof params.name === "string") headers["mcp-name"] = params.name;
  return mcpRequest(
    {
      id: 1,
      jsonrpc: "2.0",
      method,
      params: {
        ...params,
        _meta: {
          ...call.meta,
          "io.modelcontextprotocol/clientCapabilities": call.capabilities ?? CAPS_ALL,
          "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        },
      },
    },
    headers,
  );
}

type JsonRpc = {
  readonly error?: { readonly code: number; readonly data?: unknown; readonly message: string };
  readonly result?: Record<string, any>;
};

function postHandler(channel: ReturnType<typeof mcpChannel>) {
  const route = channel.routes.find((entry) => entry.method === "POST")!;
  if (route.transport === "websocket") throw new Error("expected HTTP route");
  return route.handler;
}

async function rpc(
  channel: ReturnType<typeof mcpChannel>,
  request: Request,
  args: RouteHandlerArgs,
): Promise<JsonRpc> {
  return (await jsonRpcResponse(await postHandler(channel)(request, args))) as JsonRpc;
}

/** A core stand-in: `deploy` needs approval, `issues` needs a sign-in until `signedIn`. */
function fakeCore(state: { signedIn?: boolean; challengeUrl?: string | null } = {}) {
  return vi.fn<InvokeToolFn>(async (name, input, options) => {
    const callId = options.callId ?? "call_new";
    const nonce = options.key === undefined ? (options.oneOffNonce ?? "nonce-1") : undefined;
    const pause = nonce === undefined ? {} : { oneOffNonce: nonce };
    if (name === "plain") {
      return {
        modelOutput: { type: "json", value: input },
        output: input,
        sandbox: { ms: 12, state: "created" },
        status: "completed",
      };
    }
    if (name === "deploy") {
      if (options.approval === undefined) return { callId, status: "approval-required", ...pause };
      if (!options.approval.approved) return { reason: "The person declined.", status: "denied" };
      if (state.signedIn === false) {
        return {
          callId,
          challenges: [{ challenge: { url: "https://idp.example/a" }, name: "linear" }],
          status: "authorization-required",
          ...pause,
        };
      }
      return {
        modelOutput: { type: "text", value: "deployed" },
        output: "deployed",
        status: "completed",
      };
    }
    if (name === "issues") {
      if (state.signedIn !== true) {
        return {
          callId,
          challenges: [
            {
              challenge:
                state.challengeUrl === null
                  ? { message: "Approve on your phone." }
                  : { url: state.challengeUrl ?? "https://idp.example/a", userCode: "ABCD" },
              name: "linear",
            },
          ],
          status: "authorization-required",
          ...pause,
        };
      }
      return {
        modelOutput: { type: "text", value: "3 issues" },
        output: { count: 3 },
        status: "completed",
      };
    }
    return {
      errorId: "err_1",
      message: `The agent has no tool named "${name}".`,
      status: "failed",
    };
  });
}

function toolsChannel(input: Partial<Parameters<typeof mcpChannel>[0]> = {}) {
  return mcpChannel({
    auth: (request) => ({
      attributes: {},
      authenticator: "test",
      principalId: request.headers.get("x-test-principal") ?? "user-1",
      principalType: "user",
    }),
    requestStateSecret: SECRET,
    ...input,
  });
}

describe("mcpChannel tools", () => {
  it("lists invocable tools in order with schemas as compiled, approval meta, and cache hints", async () => {
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription });
    const listed = await rpc(channel, modernRequest("tools/list"), args);

    expect(listed.result).toEqual({
      cacheScope: "private",
      resultType: "complete",
      tools: [
        {
          _meta: { "dev.eve/approval": true },
          description: "Deploys.",
          inputSchema: toolsDescription.tools[0]!.inputSchema,
          name: "deploy",
        },
        { description: "Reads issues.", inputSchema: { type: "object" }, name: "issues" },
        {
          description: "Echoes.",
          inputSchema: toolsDescription.tools[3]!.inputSchema,
          name: "plain",
          outputSchema: toolsDescription.tools[3]!.outputSchema,
        },
      ],
      ttlMs: 300_000,
      _meta: expect.anything(),
    });

    const discovered = await rpc(channel, modernRequest("server/discover"), args);
    expect(discovered.result).toMatchObject({ cacheScope: "private", ttlMs: 300_000 });
  });

  it("keeps the 2025-11-25 fallback listing the same tools", async () => {
    const listed = await rpc(
      toolsChannel(),
      mcpRequest({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      routeArgs({ description: toolsDescription }),
    );
    expect(listed.result?.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "deploy",
      "issues",
      "plain",
    ]);
  });

  it("tools: false removes the capability, the extension, the list, and calls", async () => {
    const invokeTool = fakeCore();
    const channel = toolsChannel({ tools: false });
    const args = routeArgs({ description: toolsDescription, invokeTool });

    const discovered = await rpc(channel, modernRequest("server/discover"), args);
    expect(discovered.result?.capabilities.tools).toBeUndefined();
    expect(discovered.result?.capabilities.extensions?.["dev.eve/tool-sessions"]).toBeUndefined();

    const listed = await rpc(channel, modernRequest("tools/list"), args);
    expect(listed.error?.code).toBe(-32_601);
    const called = await rpc(
      channel,
      modernRequest("tools/call", { arguments: { x: 1 }, name: "plain" }),
      args,
    );
    expect(called.error?.code).toBe(-32_601);
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("maps a completed call: content, structuredContent, sandbox meta, and the call options", async () => {
    const invokeTool = fakeCore();
    const called = await rpc(
      toolsChannel(),
      modernRequest("tools/call", { arguments: { x: 1 }, name: "plain" }, keyedCall("thread-1")),
      routeArgs({ description: toolsDescription, invokeTool }),
    );

    expect(called.result).toMatchObject({
      _meta: { "dev.eve/sandbox": { ms: 12, state: "created" } },
      content: [{ text: '{"x":1}', type: "text" }],
      structuredContent: { x: 1 },
    });
    expect(called.result?.isError).toBeUndefined();
    const [, input, options] = invokeTool.mock.calls[0]!;
    expect(input).toEqual({ x: 1 });
    expect(options.auth.principalId).toBe("user-1");
    expect(options.key).toBe("thread-1");
    expect(options.forwarder).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.callId).toBeUndefined();
  });

  it("maps failed, invalid-input, and denied to isError results, keeping sandbox meta", async () => {
    const results = [
      [
        { errorId: "err_9", message: "Boom.", status: "failed" },
        "internal",
        "Boom. (errorId: err_9)",
      ],
      [
        { message: "x must be a number.", status: "invalid-input" },
        "invalid_input",
        "x must be a number.",
      ],
      [{ reason: "Read-only.", status: "denied" }, "denied", "Read-only."],
      [{ status: "denied" }, "denied", "The call was denied."],
    ] as const;
    for (const [result, code, text] of results) {
      const called = await rpc(
        toolsChannel(),
        modernRequest("tools/call", { arguments: {}, name: "plain" }),
        routeArgs({
          description: toolsDescription,
          invokeTool: async () => ({ ...result, sandbox: { ms: 1, state: "reused" } }),
        }),
      );
      expect(called.result).toMatchObject({
        _meta: { "dev.eve/sandbox": { ms: 1, state: "reused" } },
        content: [{ text, type: "text" }],
        isError: true,
        structuredContent: { error: { code, retryable: false } },
      });
    }
  });

  it("never runs unknown or non-invocable tools", async () => {
    const invokeTool = fakeCore();
    for (const name of ["missing", "harness_only"]) {
      const called = await rpc(
        toolsChannel(),
        modernRequest("tools/call", { arguments: {}, name }),
        routeArgs({ description: toolsDescription, invokeTool }),
      );
      expect(called.error?.code).toBe(-32_602);
    }
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("refuses a non-string tool session key as invalid_input", async () => {
    const invokeTool = fakeCore();
    const called = await rpc(
      toolsChannel(),
      modernRequest("tools/call", { arguments: {}, name: "plain" }, keyedCall(7)),
      routeArgs({ description: toolsDescription, invokeTool }),
    );
    expect(called.result?.structuredContent.error.code).toBe("invalid_input");
    expect(invokeTool).not.toHaveBeenCalled();
  });

  it("asks for approval with a signed requestState and honors the answer on the retry", async () => {
    const invokeTool = fakeCore();
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const first = await rpc(
      channel,
      modernRequest("tools/call", { arguments: { env: "prod" }, name: "deploy" }),
      args,
    );
    expect(first.result).toMatchObject({
      _meta: { "dev.eve/approval": { callId: "call_new", tool: "deploy" } },
      inputRequests: {
        "dev.eve/approval": {
          method: "elicitation/create",
          params: {
            message: 'Allow the tool "deploy" to run?',
            mode: "form",
            requestedSchema: {
              properties: { approved: { title: "Approve", type: "boolean" } },
              required: ["approved"],
              type: "object",
            },
          },
        },
      },
      resultType: "input_required",
    });
    const requestState = first.result?.requestState as string;
    expect(requestState.startsWith("v1.")).toBe(true);

    const approved = await rpc(
      channel,
      modernRequest("tools/call", {
        arguments: { env: "prod" },
        inputResponses: { "dev.eve/approval": { action: "accept", content: { approved: true } } },
        name: "deploy",
        requestState,
      }),
      args,
    );
    expect(approved.result).toMatchObject({ content: [{ text: "deployed", type: "text" }] });
    expect(invokeTool.mock.calls[1]![2]).toMatchObject({
      approval: { approved: true },
      callId: "call_new",
      oneOffNonce: "nonce-1",
    });
  });

  it("treats decline, cancel, and approved:false as a denial", async () => {
    const channel = toolsChannel();
    for (const response of [
      { action: "decline" },
      { action: "cancel" },
      { action: "accept", content: { approved: false } },
    ]) {
      const invokeTool = fakeCore();
      const args = routeArgs({ description: toolsDescription, invokeTool });
      const first = await rpc(
        channel,
        modernRequest("tools/call", { arguments: {}, name: "deploy" }),
        args,
      );
      const retried = await rpc(
        channel,
        modernRequest("tools/call", {
          arguments: {},
          inputResponses: { "dev.eve/approval": response },
          name: "deploy",
          requestState: first.result?.requestState,
        }),
        args,
      );
      expect(retried.result?.structuredContent).toEqual({
        error: { code: "denied", message: "The person declined.", retryable: false },
      });
      expect(invokeTool.mock.calls[1]![2].approval).toEqual({ approved: false });
    }
  });

  it("asks again, never declines, when the retry carries no answer", async () => {
    const invokeTool = fakeCore();
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const first = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "deploy" }),
      args,
    );
    const again = await rpc(
      channel,
      modernRequest("tools/call", {
        arguments: {},
        inputResponses: { "dev.eve/approval": { action: "accept", content: {} } },
        name: "deploy",
        requestState: first.result?.requestState,
      }),
      args,
    );
    expect(again.result).toMatchObject({
      _meta: { "dev.eve/approval": { callId: "call_new", tool: "deploy" } },
      inputRequests: { "dev.eve/approval": { params: { mode: "form" } } },
      resultType: "input_required",
    });
    // Asked again from the signed state: core does not run on a missing answer.
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(decodeState(again.result?.requestState)).toMatchObject({
      callId: "call_new",
      kind: "approval",
      nonce: "nonce-1",
    });

    const approved = await rpc(
      channel,
      modernRequest("tools/call", {
        arguments: {},
        inputResponses: { "dev.eve/approval": { action: "accept", content: { approved: true } } },
        name: "deploy",
        requestState: again.result?.requestState,
      }),
      args,
    );
    expect(approved.result?.content).toEqual([{ text: "deployed", type: "text" }]);
    expect(invokeTool.mock.calls[1]![2]).toMatchObject({
      approval: { approved: true },
      callId: "call_new",
      oneOffNonce: "nonce-1",
    });
  });

  it("ignores inputResponses without a requestState", async () => {
    const invokeTool = fakeCore();
    const called = await rpc(
      toolsChannel(),
      modernRequest("tools/call", {
        arguments: {},
        inputResponses: { "dev.eve/approval": { action: "accept", content: { approved: true } } },
        name: "deploy",
      }),
      routeArgs({ description: toolsDescription, invokeTool }),
    );
    expect(called.result?.resultType).toBe("input_required");
    expect(invokeTool.mock.calls[0]![2].approval).toBeUndefined();
  });

  it("refuses a forged, edited, or rebound requestState with -32602", async () => {
    const invokeTool = fakeCore();
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const keyed = keyedCall("k1");
    const first = await rpc(
      channel,
      modernRequest("tools/call", { arguments: { env: "prod" }, name: "deploy" }, keyed),
      args,
    );
    const requestState = first.result?.requestState as string;
    const answer = { "dev.eve/approval": { action: "accept", content: { approved: true } } };
    const retries: Array<[Record<string, unknown>, ModernCall]> = [
      [{ arguments: { env: "prod" }, name: "deploy", requestState: `${requestState}x` }, keyed],
      [{ arguments: { env: "prod" }, name: "deploy", requestState: "v1.e30.AAAA" }, keyed],
      [{ arguments: { env: "dev" }, name: "deploy", requestState }, keyed],
      [{ arguments: { env: "prod" }, name: "plain", requestState }, keyed],
      [{ arguments: { env: "prod" }, name: "deploy", requestState }, keyedCall("k2")],
      [{ arguments: { env: "prod" }, name: "deploy", requestState }, {}],
      // The same key from a client that did not declare tool sessions is
      // ignored, so the retry is one-off and cannot match the keyed state.
      [
        { arguments: { env: "prod" }, name: "deploy", requestState },
        { meta: { "dev.eve/tool-session": "k1" } },
      ],
      [
        { arguments: { env: "prod" }, name: "deploy", requestState },
        { ...keyed, headers: { "x-test-principal": "user-2" } },
      ],
    ];
    for (const [params, call] of retries) {
      const refused = await rpc(
        channel,
        modernRequest("tools/call", { ...params, inputResponses: answer }, call),
        args,
      );
      expect(refused.error).toEqual({
        code: -32_602,
        data: { reason: "invalid_request_state" },
        message: "Invalid or expired requestState",
      });
    }
    expect(invokeTool).toHaveBeenCalledTimes(1);

    // A second channel holding only the same secret accepts the honest retry.
    const other = toolsChannel();
    const accepted = await rpc(
      other,
      modernRequest(
        "tools/call",
        { arguments: { env: "prod" }, inputResponses: answer, name: "deploy", requestState },
        keyed,
      ),
      args,
    );
    expect(accepted.result?.content).toEqual([{ text: "deployed", type: "text" }]);
    expect(invokeTool.mock.calls[1]![2]).toMatchObject({ callId: "call_new", key: "k1" });
    expect(invokeTool.mock.calls[1]![2].oneOffNonce).toBeUndefined();

    // Another secret does not.
    const foreign = toolsChannel({ requestStateSecret: "y".repeat(32) });
    const rejected = await rpc(
      foreign,
      modernRequest(
        "tools/call",
        { arguments: { env: "prod" }, inputResponses: answer, name: "deploy", requestState },
        keyed,
      ),
      args,
    );
    expect(rejected.error?.code).toBe(-32_602);
  });

  it("asks for each sign-in by URL and retries into the same session", async () => {
    const core = { signedIn: false };
    const invokeTool = fakeCore(core);
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const first = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "issues" }),
      args,
    );
    expect(first.result).toMatchObject({
      _meta: { "dev.eve/authorization": { callId: "call_new", connections: ["linear"] } },
      inputRequests: {
        "dev.eve/authorization:linear": {
          method: "elicitation/create",
          params: {
            message: "Sign in to linear to continue. Code: ABCD",
            mode: "url",
            url: "https://idp.example/a",
          },
        },
      },
      resultType: "input_required",
    });

    const retry = (requestState: unknown) =>
      rpc(
        channel,
        modernRequest("tools/call", {
          arguments: {},
          inputResponses: { "dev.eve/authorization:linear": { action: "accept" } },
          name: "issues",
          requestState,
        }),
        args,
      );
    const early = await retry(first.result?.requestState);
    expect(early.result?.resultType).toBe("input_required");
    core.signedIn = true;
    const done = await retry(early.result?.requestState);
    expect(done.result).toMatchObject({ structuredContent: { count: 3 } });
    expect(invokeTool.mock.calls[2]![2]).toMatchObject({
      callId: "call_new",
      oneOffNonce: "nonce-1",
    });
  });

  it("carries the approval answer into the sign-in round that follows it", async () => {
    const core = { signedIn: false };
    const invokeTool = fakeCore(core);
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const asked = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "deploy" }),
      args,
    );
    const signIn = await rpc(
      channel,
      modernRequest("tools/call", {
        arguments: {},
        inputResponses: { "dev.eve/approval": { action: "accept", content: { approved: true } } },
        name: "deploy",
        requestState: asked.result?.requestState,
      }),
      args,
    );
    expect(signIn.result?.inputRequests).toHaveProperty(["dev.eve/authorization:linear"]);
    core.signedIn = true;
    const done = await rpc(
      channel,
      modernRequest("tools/call", {
        arguments: {},
        inputResponses: {
          "dev.eve/approval": { action: "decline" },
          "dev.eve/authorization:linear": { action: "accept" },
        },
        name: "deploy",
        requestState: signIn.result?.requestState,
      }),
      args,
    );
    // The carried answer wins; an approval response on a sign-in round is ignored.
    expect(done.result?.content).toEqual([{ text: "deployed", type: "text" }]);
    expect(invokeTool.mock.calls[2]![2].approval).toEqual({ approved: true });
  });

  it("asks again for a missing sign-in answer without calling core, even once signed in", async () => {
    const core = { signedIn: false };
    const invokeTool = fakeCore(core);
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const first = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "issues" }),
      args,
    );
    expect(decodeState(first.result?.requestState)).toMatchObject({
      authorization: [{ name: "linear", url: "https://idp.example/a", userCode: "ABCD" }],
      kind: "authorization",
    });
    // Credentials arrive in another tab, but the retry answers nothing.
    core.signedIn = true;
    for (const inputResponses of [
      undefined,
      {},
      { "dev.eve/approval": { action: "accept", content: { approved: true } } },
    ]) {
      const params: Record<string, unknown> = {
        arguments: {},
        name: "issues",
        requestState: first.result?.requestState,
      };
      if (inputResponses !== undefined) params.inputResponses = inputResponses;
      const again = await rpc(channel, modernRequest("tools/call", params), args);
      expect(again.result).toMatchObject({
        _meta: { "dev.eve/authorization": { callId: "call_new", connections: ["linear"] } },
        inputRequests: {
          "dev.eve/authorization:linear": {
            method: "elicitation/create",
            params: {
              message: "Sign in to linear to continue. Code: ABCD",
              mode: "url",
              url: "https://idp.example/a",
            },
          },
        },
        resultType: "input_required",
      });
      expect(again.result?.structuredContent).toBeUndefined();
    }
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  it("denies a declined or cancelled sign-in without calling core, naming the connection", async () => {
    for (const [action, word] of [
      ["decline", "declined"],
      ["cancel", "cancelled"],
    ] as const) {
      const core = { signedIn: false };
      const invokeTool = fakeCore(core);
      const channel = toolsChannel();
      const args = routeArgs({ description: toolsDescription, invokeTool });
      const first = await rpc(
        channel,
        modernRequest("tools/call", { arguments: {}, name: "issues" }),
        args,
      );
      // Even with a grant now in place, the refusal stands.
      core.signedIn = true;
      const refused = await rpc(
        channel,
        modernRequest("tools/call", {
          arguments: {},
          inputResponses: { "dev.eve/authorization:linear": { action } },
          name: "issues",
          requestState: first.result?.requestState,
        }),
        args,
      );
      expect(refused.result).toMatchObject({
        content: [{ text: `The sign-in to "linear" was ${word}.`, type: "text" }],
        isError: true,
        structuredContent: {
          error: { code: "denied", message: `The sign-in to "linear" was ${word}.` },
        },
      });
      expect(invokeTool).toHaveBeenCalledTimes(1);
    }
  });

  it("handles partial sign-in answers: re-asks only what is missing, and a refusal wins", async () => {
    const signedIn = { github: false, linear: false };
    const invokeTool = vi.fn<InvokeToolFn>(async (_name, _input, options) => {
      const challenges = (["github", "linear"] as const)
        .filter((name) => !signedIn[name])
        .map((name) => ({ challenge: { url: `https://idp.example/${name}` }, name }));
      if (challenges.length > 0) {
        return {
          callId: options.callId ?? "call_new",
          challenges,
          oneOffNonce: options.oneOffNonce ?? "nonce-1",
          status: "authorization-required",
        };
      }
      return {
        modelOutput: { type: "text", value: "ok" },
        output: { ok: true },
        status: "completed",
      };
    });
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const call = (requestState: unknown, inputResponses: Record<string, unknown>) =>
      rpc(
        channel,
        modernRequest("tools/call", {
          arguments: {},
          inputResponses,
          name: "issues",
          requestState,
        }),
        args,
      );
    const first = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "issues" }),
      args,
    );
    expect(Object.keys(first.result?.inputRequests ?? {})).toEqual([
      "dev.eve/authorization:github",
      "dev.eve/authorization:linear",
    ]);

    // One declined, one missing: denied, naming the declined connection.
    const mixed = await call(first.result?.requestState, {
      "dev.eve/authorization:github": { action: "decline" },
    });
    expect(mixed.result?.structuredContent.error).toMatchObject({
      code: "denied",
      message: 'The sign-in to "github" was declined.',
    });
    expect(invokeTool).toHaveBeenCalledTimes(1);

    // One accepted, one missing: only the missing one is asked again.
    const partial = await call(first.result?.requestState, {
      "dev.eve/authorization:github": { action: "accept" },
    });
    expect(partial.result?.resultType).toBe("input_required");
    expect(Object.keys(partial.result?.inputRequests ?? {})).toEqual([
      "dev.eve/authorization:linear",
    ]);
    expect(partial.result?._meta).toMatchObject({
      "dev.eve/authorization": { callId: "call_new", connections: ["linear"] },
    });
    expect(decodeState(partial.result?.requestState).authorization).toEqual([
      { name: "linear", url: "https://idp.example/linear" },
    ]);
    expect(invokeTool).toHaveBeenCalledTimes(1);

    // The rest answered: core runs and re-checks every grant itself.
    signedIn.github = true;
    signedIn.linear = true;
    const done = await call(partial.result?.requestState, {
      "dev.eve/authorization:linear": { action: "accept" },
    });
    expect(done.result?.structuredContent).toEqual({ ok: true });
    expect(invokeTool).toHaveBeenCalledTimes(2);
    expect(invokeTool.mock.calls[1]![2]).toMatchObject({
      callId: "call_new",
      oneOffNonce: "nonce-1",
    });
  });

  it("keeps the approval through a sign-in round asked again, and denies a cancelled one", async () => {
    const core = { signedIn: false };
    const invokeTool = fakeCore(core);
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const call = (requestState: unknown, inputResponses: Record<string, unknown>) =>
      rpc(
        channel,
        modernRequest("tools/call", {
          arguments: {},
          inputResponses,
          name: "deploy",
          requestState,
        }),
        args,
      );
    const asked = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "deploy" }),
      args,
    );
    const signIn = await call(asked.result?.requestState, {
      "dev.eve/approval": { action: "accept", content: { approved: true } },
    });
    expect(decodeState(signIn.result?.requestState)).toMatchObject({
      approval: { approved: true },
      kind: "authorization",
    });

    // Missing answer: asked again, the approval still carried, core not run.
    const again = await call(signIn.result?.requestState, {});
    expect(again.result?.inputRequests).toHaveProperty(["dev.eve/authorization:linear"]);
    expect(decodeState(again.result?.requestState)).toMatchObject({
      approval: { approved: true },
      kind: "authorization",
    });
    expect(invokeTool).toHaveBeenCalledTimes(2);

    // Accepted but not yet authorized: core runs with the approval and asks again.
    const early = await call(again.result?.requestState, {
      "dev.eve/authorization:linear": { action: "accept" },
    });
    expect(early.result?.resultType).toBe("input_required");
    expect(invokeTool.mock.calls[2]![2].approval).toEqual({ approved: true });

    // A cancel on that round denies, even though the approval was given.
    core.signedIn = true;
    const cancelled = await call(early.result?.requestState, {
      "dev.eve/authorization:linear": { action: "cancel" },
    });
    expect(cancelled.result?.structuredContent.error).toMatchObject({ code: "denied" });
    expect(invokeTool).toHaveBeenCalledTimes(3);

    const done = await call(early.result?.requestState, {
      "dev.eve/authorization:linear": { action: "accept" },
    });
    expect(done.result?.content).toEqual([{ text: "deployed", type: "text" }]);
    expect(invokeTool.mock.calls[3]![2].approval).toEqual({ approved: true });
  });

  it("does not restore an approval into a round that never carried one", async () => {
    const core = { signedIn: false };
    const invokeTool = fakeCore(core);
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const first = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "issues" }),
      args,
    );
    expect(decodeState(first.result?.requestState).approval).toBeUndefined();
    core.signedIn = true;
    await rpc(
      channel,
      modernRequest("tools/call", {
        arguments: {},
        inputResponses: {
          "dev.eve/approval": { action: "accept", content: { approved: true } },
          "dev.eve/authorization:linear": { action: "accept" },
        },
        name: "issues",
        requestState: first.result?.requestState,
      }),
      args,
    );
    expect(invokeTool.mock.calls[1]![2].approval).toBeUndefined();
  });

  it("uses the tool session key only when the client declared dev.eve/tool-sessions", async () => {
    const invokeTool = fakeCore();
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });

    const declared = await rpc(
      channel,
      modernRequest("tools/call", { arguments: { x: 1 }, name: "plain" }, keyedCall("thread-1")),
      args,
    );
    expect(declared.result?.structuredContent).toEqual({ x: 1 });
    expect(invokeTool.mock.calls[0]![2].key).toBe("thread-1");

    // Declared but no key: one-off.
    await rpc(
      channel,
      modernRequest(
        "tools/call",
        { arguments: { x: 1 }, name: "plain" },
        { capabilities: CAPS_SESSIONS },
      ),
      args,
    );
    expect(invokeTool.mock.calls[1]![2].key).toBeUndefined();

    // Not declared: a stray key, valid or not, is ignored rather than used or refused.
    for (const stray of ["thread-1", 7, "x".repeat(10_000)]) {
      const undeclared = await rpc(
        channel,
        modernRequest(
          "tools/call",
          { arguments: { x: 1 }, name: "plain" },
          { meta: { "dev.eve/tool-session": stray } },
        ),
        args,
      );
      expect(undeclared.result?.structuredContent).toEqual({ x: 1 });
      expect(invokeTool.mock.lastCall![2].key).toBeUndefined();
    }
    // A declared extension that is not an object is not a declaration.
    await rpc(
      channel,
      modernRequest(
        "tools/call",
        { arguments: { x: 1 }, name: "plain" },
        {
          capabilities: { ...CAPS_ALL, extensions: { "dev.eve/tool-sessions": true } },
          meta: { "dev.eve/tool-session": "thread-1" },
        },
      ),
      args,
    );
    expect(invokeTool.mock.lastCall![2].key).toBeUndefined();
  });

  it("mints and binds one-off state for an undeclared client that sends a stray key", async () => {
    const invokeTool = fakeCore();
    const channel = toolsChannel();
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const stray = { meta: { "dev.eve/tool-session": "thread-1" } };
    const answer = { "dev.eve/approval": { action: "accept", content: { approved: true } } };
    const first = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "deploy" }, stray),
      args,
    );
    expect(invokeTool.mock.calls[0]![2].key).toBeUndefined();
    const payload = decodeState(first.result?.requestState);
    expect(payload.nonce).toBe("nonce-1");

    // Declaring the extension on the retry with the same key does not reach the one-off state.
    const declared = await rpc(
      channel,
      modernRequest(
        "tools/call",
        {
          arguments: {},
          inputResponses: answer,
          name: "deploy",
          requestState: first.result?.requestState,
        },
        keyedCall("thread-1"),
      ),
      args,
    );
    expect(declared.error?.code).toBe(-32_602);
    expect(invokeTool).toHaveBeenCalledTimes(1);

    // The undeclared retry, stray key and all, is the one-off session.
    const retried = await rpc(
      channel,
      modernRequest(
        "tools/call",
        {
          arguments: {},
          inputResponses: answer,
          name: "deploy",
          requestState: first.result?.requestState,
        },
        stray,
      ),
      args,
    );
    expect(retried.result?.content).toEqual([{ text: "deployed", type: "text" }]);
    expect(invokeTool.mock.calls[1]![2]).toMatchObject({ oneOffNonce: "nonce-1" });
    expect(invokeTool.mock.calls[1]![2].key).toBeUndefined();

    // And a keyed state from a declared client does not carry a nonce.
    const keyed = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "deploy" }, keyedCall("thread-1")),
      args,
    );
    expect(decodeState(keyed.result?.requestState).nonce).toBeUndefined();
  });

  it("refuses input the client cannot render, before minting anything", async () => {
    const cases: Array<[string, Readonly<Record<string, unknown>>]> = [
      ["deploy", {}],
      ["deploy", { elicitation: { url: {} } }],
      ["issues", { elicitation: {} }],
      ["issues", { elicitation: { form: {} } }],
    ];
    for (const [name, capabilities] of cases) {
      const called = await rpc(
        toolsChannel(),
        modernRequest("tools/call", { arguments: {}, name }, { capabilities }),
        routeArgs({ description: toolsDescription, invokeTool: fakeCore() }),
      );
      expect(called.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "input_unsupported" } },
      });
    }
    // A bare `elicitation: {}` implies form mode.
    const bare = await rpc(
      toolsChannel(),
      modernRequest(
        "tools/call",
        { arguments: {}, name: "deploy" },
        { capabilities: { elicitation: {} } },
      ),
      routeArgs({ description: toolsDescription, invokeTool: fakeCore() }),
    );
    expect(bare.result?.resultType).toBe("input_required");
  });

  it("refuses a sign-in challenge without a URL, naming the connection", async () => {
    const called = await rpc(
      toolsChannel(),
      modernRequest("tools/call", { arguments: {}, name: "issues" }),
      routeArgs({ description: toolsDescription, invokeTool: fakeCore({ challengeUrl: null }) }),
    );
    expect(called.result).toMatchObject({ isError: true });
    expect(called.result?.structuredContent.error.message).toContain('"linear"');
  });

  it("answers input_unsupported on the stateless 2025 fallback", async () => {
    const called = await rpc(
      toolsChannel(),
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: {}, name: "deploy" },
      }),
      routeArgs({ description: toolsDescription, invokeTool: fakeCore() }),
    );
    expect(called.result?.structuredContent.error.code).toBe("input_unsupported");
  });

  it("without a secret in production, fails paused calls naming the env var and runs plain ones", async () => {
    const previous = { env: process.env.EVE_MCP_REQUEST_STATE_SECRET, dev: process.env.EVE_DEV };
    delete process.env.EVE_MCP_REQUEST_STATE_SECRET;
    delete process.env.EVE_DEV;
    try {
      const channel = toolsChannel({ requestStateSecret: undefined });
      const args = routeArgs({ description: toolsDescription, invokeTool: fakeCore() });
      const paused = await rpc(
        channel,
        modernRequest("tools/call", { arguments: {}, name: "deploy" }),
        args,
      );
      expect(paused.result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "internal" } },
      });
      expect(paused.result?.structuredContent.error.message).toContain(
        "EVE_MCP_REQUEST_STATE_SECRET",
      );
      expect(paused.result?.requestState).toBeUndefined();

      const plain = await rpc(
        channel,
        modernRequest("tools/call", { arguments: { x: 2 }, name: "plain" }),
        args,
      );
      expect(plain.result?.structuredContent).toEqual({ x: 2 });

      const echoed = await rpc(
        channel,
        modernRequest("tools/call", { arguments: {}, name: "deploy", requestState: "anything" }),
        args,
      );
      expect(echoed.error?.code).toBe(-32_602);
    } finally {
      if (previous.env !== undefined) process.env.EVE_MCP_REQUEST_STATE_SECRET = previous.env;
      if (previous.dev !== undefined) process.env.EVE_DEV = previous.dev;
    }
  });

  it("calls as the forwarded principal, with the forwarder in the session id", async () => {
    const invokeTool = fakeCore();
    const channel = toolsChannel({ trustedForwarders: () => true });
    const args = routeArgs({ description: toolsDescription, invokeTool });
    const header = Buffer.from(
      JSON.stringify({
        current: {
          attributes: {},
          authenticator: "oidc",
          principalId: "end-user",
          principalType: "user",
        },
      }),
    ).toString("base64url");
    const forwarded = {
      headers: { "eve-forwarded-principal": header, "x-test-principal": "router" },
    };
    const first = await rpc(
      channel,
      modernRequest("tools/call", { arguments: {}, name: "deploy" }, forwarded),
      args,
    );
    expect(invokeTool.mock.calls[0]![2]).toMatchObject({
      auth: { attributes: { "eve:forwarded-by": "router" }, principalId: "end-user" },
      forwarder: { principalId: "router" },
      initiator: { principalId: "end-user" },
    });

    // The same state replayed by the same user without the forwarder is refused.
    const answer = { "dev.eve/approval": { action: "accept", content: { approved: true } } };
    const replayed = await rpc(
      channel,
      modernRequest(
        "tools/call",
        {
          arguments: {},
          inputResponses: answer,
          name: "deploy",
          requestState: first.result?.requestState,
        },
        { headers: { "x-test-principal": "end-user" } },
      ),
      args,
    );
    expect(replayed.error?.code).toBe(-32_602);

    const malformed = await postHandler(channel)(
      modernRequest("server/discover", {}, { headers: { "eve-forwarded-principal": "!!" } }),
      args,
    );
    expect(malformed.status).toBe(400);
  });

  it("acknowledges subscriptions/listen, then closes the stream without a result", async () => {
    const response = await postHandler(toolsChannel())(
      modernRequest("subscriptions/listen", {
        notifications: { promptsListChanged: true, toolsListChanged: true },
      }),
      routeArgs({ description: toolsDescription }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    const events = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { notifications: { toolsListChanged: true } },
    });
    expect(events[0].params.notifications.promptsListChanged).toBeUndefined();
  });
});
