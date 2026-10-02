import { parseJsonObject } from "#shared/json.js";
import { z } from "#compiled/zod/index.js";
import {
  defineChannel,
  DELETE,
  GET,
  HEAD,
  OPTIONS,
  POST,
  type Channel,
} from "#public/definitions/channel.js";
import type { AgentDescription } from "#channel/agent-description.js";
import type { TrustedForwarders } from "#channel/forwarded-principal.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import type { SessionAuthContext } from "#channel/types.js";
import type {
  AgentInvocation,
  AgentInvocationMutationResult,
} from "#internal/invocation/agent-invocation.js";
import { WorkflowAgentInvocationExecution } from "#internal/invocation/workflow-execution.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  resolveMcpRequestPrincipals,
  type McpRequestPrincipals,
} from "#internal/mcp/forwarded-principal-header.js";
import { createMcpSkillsFeature } from "#internal/mcp/skills.js";
import { validateMcpHttpRequest } from "#internal/mcp/http-security.js";
import {
  createMcpRequestStateCodec,
  resolveMcpRequestStateSecret,
  type McpRequestStateCodec,
} from "#internal/mcp/request-state.js";
import { defineMcpTool } from "#internal/mcp/define-tool.js";
import {
  createMcpStreamableHttpServer,
  MCP_LIST_CACHE_HINT,
  McpToolOperationError,
  type McpCallToolResult,
  type McpServerFeature,
  type McpServerTool,
} from "#internal/mcp/streamable-http-server.js";
import {
  MCP_TOOLS_CAPABILITIES,
  registerMcpTools,
  type McpToolsRequestState,
} from "#internal/mcp/tools.js";
import {
  addResourceChallenge,
  protectedResourceMetadataOptionsResponse,
  protectedResourceMetadataPath,
  protectedResourceMetadataResponse,
} from "#internal/mcp/protected-resource.js";
import {
  readOAuthResourceOptions,
  routeAuth,
  type AuthFn,
  type OAuthResourceOptions,
} from "#public/channels/auth.js";
import {
  readRouteChannelName,
  readRouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { inputRequestSchema, inputResponseSchema } from "#shared/input.js";

export type { ForwardedAssertion, TrustedForwarders } from "#channel/forwarded-principal.js";

const log = createLogger("mcp.channel");

export interface McpChannelInput {
  /** Existing eve route-auth policy. Use `none()` for explicit public access. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** Override the default MCP route path (`/eve/v1/mcp`). */
  readonly route?: string;
  /**
   * Serve the `agent_*` tools, which start and follow a durable agent task.
   * With `false`, the channel serves only what `tools` and `skills` publish,
   * and the `agent_*` names are not reserved.
   * @default true
   */
  readonly agent?: boolean;
  /**
   * Also publish the agent's invocable tools over `tools/list` and
   * `tools/call`. `true` adds the `dev.eve/tool-sessions` extension to
   * `server/discover`. While `agent` is on, its `agent_*` names stay
   * reserved: an agent tool with one of them is not published.
   * @default false
   */
  readonly tools?: boolean;
  /** Publish the agent's skills (SEP-2640). @default false */
  readonly skills?: boolean;
  /**
   * Accepts the `eve-forwarded-principal` header from route-authenticated
   * forwarders this predicate trusts, the way `eveChannel` accepts its
   * `forwardedPrincipal` body field. Without it the header is ignored.
   */
  readonly trustedForwarders?: TrustedForwarders;
  /**
   * HMAC secret for the `requestState` of approval and sign-in rounds, at
   * least 32 bytes and the same on every instance. During `eve dev` a
   * per-process random key is used when neither is set.
   * @default process.env.EVE_MCP_REQUEST_STATE_SECRET
   */
  readonly requestStateSecret?: string;
}

/** Public MCP channel publishing this agent, and optionally its tools and skills, as an MCP server. */
export type McpChannel = Channel;

interface McpChannelConfig {
  readonly agent: boolean;
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  readonly oauth: OAuthResourceOptions | undefined;
  readonly requestState: () => McpToolsRequestState;
  readonly skills: boolean;
  readonly tools: boolean;
  readonly trustedForwarders: TrustedForwarders | undefined;
}

/**
 * Publishes this agent as a stateless Streamable HTTP MCP server.
 *
 * This channel owns MCP transport, authentication, and durable eve invocation.
 * It reuses eve's inbound auth strategies and recognizes `oauthResource(...)`
 * metadata when OAuth discovery is needed. It serves the `agent_*` invocation
 * tools unless `agent: false`. With `tools: true` it also publishes the
 * agent's invocable tools (each call runs through `invokeTool` in a tool
 * session), and with `skills: true` its skills.
 * The file containing this channel must be `agent/channels/mcp.ts`.
 */
export function mcpChannel(input: McpChannelInput): McpChannel {
  if (input?.auth === undefined) {
    throw new Error("mcpChannel requires auth. Use none() for explicit public access.");
  }
  const agent = input.agent ?? true;
  const tools = input.tools ?? false;
  const skills = input.skills ?? false;
  if (!agent && !tools && !skills) {
    throw new Error(
      "mcpChannel publishes nothing with agent, tools, and skills all false. Enable at least one.",
    );
  }
  const path = input.route ?? "/eve/v1/mcp";
  const oauth = readOAuthResourceOptions(input.auth);
  // A bad option is an authoring error: fail at load, not on the first call.
  const optionSecret =
    input.requestStateSecret === undefined
      ? undefined
      : resolveMcpRequestStateSecret(input.requestStateSecret);
  let requestState: McpToolsRequestState | undefined;
  const config: McpChannelConfig = {
    agent,
    auth: input.auth,
    oauth,
    requestState() {
      requestState ??= toRequestState(optionSecret ?? resolveMcpRequestStateSecret(undefined));
      return requestState;
    },
    skills,
    tools,
    trustedForwarders: input.trustedForwarders,
  };
  const handle = async (request: Request, args: RouteHandlerArgs) =>
    await authenticateMcpRequest(request, args, config);
  const routes = [GET(path, handle), POST(path, handle), DELETE(path, handle)];
  if (oauth !== undefined) {
    routes.unshift(...protectedResourceMetadataRoutes(oauth, path));
  }
  return defineChannel({ routes });
}

function toRequestState(
  secret: ReturnType<typeof resolveMcpRequestStateSecret>,
): McpToolsRequestState {
  if (secret.kind === "missing") return { kind: "missing", reason: secret.reason };
  const codec: McpRequestStateCodec = createMcpRequestStateCodec(secret.key);
  return { codec, kind: "codec" };
}

function protectedResourceMetadataRoutes(options: OAuthResourceOptions, resourcePath: string) {
  const metadataPath = protectedResourceMetadataPath(options, resourcePath);
  return [
    GET(metadataPath, async (request) =>
      protectedResourceMetadataResponse(request, options, resourcePath, false),
    ),
    HEAD(metadataPath, async (request) =>
      protectedResourceMetadataResponse(request, options, resourcePath, true),
    ),
    OPTIONS(metadataPath, async (request) => protectedResourceMetadataOptionsResponse(request)),
  ] as const;
}

async function authenticateMcpRequest(
  request: Request,
  args: RouteHandlerArgs,
  config: McpChannelConfig,
): Promise<Response> {
  const securityFailure = validateMcpHttpRequest(request);
  if (securityFailure !== undefined) return securityFailure;
  const auth = await routeAuth(request, config.auth);
  if (auth instanceof Response) {
    return config.oauth === undefined ? auth : addResourceChallenge(auth, request, config.oauth);
  }
  // Every request, discover and lists included, acts as the resolved
  // principals, so a bad forwarded header fails before any MCP handling.
  const principals = await resolveMcpRequestPrincipals(request, auth, config.trustedForwarders);
  if (principals instanceof Response) return principals;
  return await handleMcpRequest(request, args, config, principals);
}

async function handleMcpRequest(
  request: Request,
  args: RouteHandlerArgs,
  config: McpChannelConfig,
  principals: McpRequestPrincipals,
): Promise<Response> {
  const createSession = readRouteSessionCreator(args);
  if (config.agent && (readRouteChannelName(args) === undefined || createSession === undefined)) {
    return Response.json({ error: "MCP requires agent route context." }, { status: 500 });
  }
  let description: AgentDescription;
  try {
    description = await args.describe();
  } catch (error) {
    const errorId = logError(log, "MCP could not describe the agent", error);
    return Response.json(
      { error: "MCP could not read the agent description.", errorId },
      { status: 500 },
    );
  }
  const agentTools =
    config.agent && createSession !== undefined
      ? createInvocationTools(
          new WorkflowAgentInvocationExecution({ createSession, from: args.from }),
          description.description,
          isPublicAccess(invocationOwner(principals)),
        )
      : [];
  const features: McpServerFeature<McpRequestPrincipals>[] = [];
  let requestState: McpToolsRequestState | undefined;
  if (config.tools) {
    requestState = config.requestState();
    const toolsRequestState = requestState;
    features.push({
      capabilities: MCP_TOOLS_CAPABILITIES,
      register(server, context) {
        registerMcpTools(server, {
          era: context.era,
          invokeTool: args.invokeTool,
          principals: context.auth,
          requestState: toolsRequestState,
          reservedTools: agentTools,
          tools: description.tools,
        });
      },
    });
  }
  features.push(...skillsFeatures(config, description, args));

  return await createMcpStreamableHttpServer<McpRequestPrincipals>({
    authenticate: async () => principals,
    cacheHints: { "server/discover": MCP_LIST_CACHE_HINT, "tools/list": MCP_LIST_CACHE_HINT },
    features,
    instructions: config.agent ? MCP_SERVER_INSTRUCTIONS : undefined,
    listen: "ack-then-close",
    name: description.name,
    requestState: {
      async verify(state, ctx) {
        // No secret means eve never minted a state: nothing echoed can verify.
        if (requestState?.kind !== "codec") throw new Error("no requestState secret");
        return await requestState.codec.verify(state, ctx);
      },
    },
    // With `tools` on, the tools feature serves `agent_*` itself (see `reservedTools`).
    tools: config.tools || !config.agent ? undefined : agentTools,
    version: resolveInstalledPackageInfo().version,
  })(request);
}

function skillsFeatures(
  config: McpChannelConfig,
  description: AgentDescription,
  args: RouteHandlerArgs,
): readonly McpServerFeature<McpRequestPrincipals>[] {
  if (!config.skills) return [];
  // The description is already computed for this request; reuse it so one
  // MCP request reads the manifest once.
  return [
    createMcpSkillsFeature({
      describe: async () => description,
      readSkill: (skill, path) => args.readSkill(skill, path),
    }),
  ];
}

/**
 * Hosted MCP clients receive this once per connection (legacy `initialize`)
 * or per discovery (`server/discover`). Keep it short: clients truncate or
 * drop long instructions, and the details live in each tool description.
 */
const MCP_SERVER_INSTRUCTIONS = [
  "Each invocation is one durable agent task.",
  "Call agent_start once per task and keep the returned invocationId.",
  "Poll agent_get, waiting at least pollAfterMs between calls, until status is completed, failed, or cancelled.",
  "If status is input_required, answer every entry in inputRequests in one agent_update call; repeating accepted answers is safe.",
  "If status is authorization_required, show the user the authorization url or instructions and keep polling.",
  "isError on a tool result means your call was rejected; a failed status means the task failed.",
  "agent_start is not idempotent and a lost response leaves no invocationId, so ask the user before starting again.",
  "Work continues after your connection drops; agent_cancel stops it, then poll until any terminal status.",
].join(" ");

/**
 * The `agent_*` tools act for the route-authenticated caller, as they did
 * before `trustedForwarders`: a forwarded principal applies to published
 * tools only, so a forwarder still owns the tasks it starts.
 */
function invocationOwner(principals: McpRequestPrincipals): SessionAuthContext {
  return principals.forwarder ?? principals.current;
}

function isPublicAccess(auth: SessionAuthContext): boolean {
  return auth.authenticator === "none" && auth.principalType === "anonymous";
}

function createInvocationTools(
  execution: WorkflowAgentInvocationExecution,
  agentDescription: string | undefined,
  publicAccess: boolean,
): readonly McpServerTool<McpRequestPrincipals>[] {
  const publicHandleDescription = publicAccess
    ? " On this public channel, the invocation ID is a bearer capability until workflow retention expires."
    : "";
  const startDescription =
    "Starts durable work and returns an invocation handle immediately. " +
    "Call once per task; keep invocationId and poll agent_get. Not idempotent: if the response is lost, " +
    `ask the user before starting again rather than retrying.${publicHandleDescription}`;
  const tools: McpServerTool<McpRequestPrincipals>[] = [
    defineMcpTool({
      definition: {
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
          readOnlyHint: false,
        },
        description:
          agentDescription === undefined
            ? startDescription
            : `${agentDescription} ${startDescription}`,
        inputSchema: z.strictObject({
          message: utf8Bounded(MAX_MESSAGE_BYTES).min(1),
        }),
        name: "agent_start",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(body, context) {
        const invocation = await execution.create({
          auth: invocationOwner(context.auth),
          message: body.message,
        });
        return invocationResult(invocation);
      },
    }),
    defineMcpTool({
      definition: {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: true,
        },
        description:
          "Reads complete durable invocation state. Wait at least pollAfterMs between calls. " +
          "Terminal statuses are completed, failed, and cancelled. input_required needs agent_update; " +
          `authorization_required needs the user to follow the returned authorization.${publicHandleDescription}`,
        inputSchema: z.strictObject({ invocationId: z.string().min(1).max(MAX_ID_CHARS) }),
        name: "agent_get",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(body, context) {
        return invocationResult(
          requiredInvocation(
            await execution.read({
              auth: invocationOwner(context.auth),
              invocationId: body.invocationId,
            }),
          ),
        );
      },
    }),
    defineMcpTool({
      definition: {
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
          readOnlyHint: false,
        },
        description:
          "Answers the pending input batch on an input_required invocation. Include one response per " +
          "entry in inputRequests, each keyed by its requestId, in a single call; partial batches are rejected. " +
          "Returns the current invocation state; repeating the same accepted answers is safe.",
        inputSchema: z.strictObject({
          invocationId: z.string().min(1).max(MAX_ID_CHARS),
          responses: z.array(MCP_INPUT_RESPONSE_SCHEMA).min(1).max(MAX_RESPONSES_PER_UPDATE),
        }),
        name: "agent_update",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(body, context) {
        return invocationResult(
          requiredMutation(
            await execution.update({
              auth: invocationOwner(context.auth),
              invocationId: body.invocationId,
              responses: body.responses,
            }),
          ),
        );
      },
    }),
    defineMcpTool({
      definition: {
        annotations: {
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        },
        description:
          "Requests cooperative cancellation of a non-terminal invocation. Cancellation is asynchronous and " +
          "can race with completion: poll agent_get until status is terminal (cancelled, completed, or failed). " +
          "Safe to call repeatedly.",
        inputSchema: z.strictObject({ invocationId: z.string().min(1).max(MAX_ID_CHARS) }),
        name: "agent_cancel",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(body, context) {
        return invocationResult(
          requiredInvocation(
            await execution.cancel({
              auth: invocationOwner(context.auth),
              invocationId: body.invocationId,
            }),
          ),
        );
      },
    }),
  ];
  return tools;
}

// Unknown, expired, and foreign-principal invocations all read as not found
// so the response never confirms that another caller's invocation exists.
const INVOCATION_NOT_FOUND =
  "Invocation not found. It may have expired or belong to another caller.";

function requiredInvocation(invocation: AgentInvocation | undefined): AgentInvocation {
  if (invocation === undefined) {
    throw new McpToolOperationError("not_found", INVOCATION_NOT_FOUND);
  }
  return invocation;
}

function requiredMutation(result: AgentInvocationMutationResult): AgentInvocation {
  switch (result.type) {
    case "success":
      return result.invocation;
    case "conflict":
      throw new McpToolOperationError(
        "conflict",
        `${result.message} Call agent_get to read the current state before answering again.`,
      );
    case "not_found":
      throw new McpToolOperationError("not_found", INVOCATION_NOT_FOUND);
  }
}

function invocationResult(invocation: AgentInvocation): McpCallToolResult {
  const structuredContent = parseJsonObject(invocation);
  return {
    content: [{ text: JSON.stringify(structuredContent), type: "text" }],
    structuredContent,
  };
}

const AUTHORIZATION_CHALLENGE_SCHEMA = z.strictObject({
  displayName: z.string().optional(),
  expiresAt: z.iso.datetime().optional(),
  instructions: z.string().optional(),
  url: z.url().optional(),
  userCode: z.string().optional(),
});

const AUTHORIZATION_REQUEST_SCHEMA = z.strictObject({
  authorization: AUTHORIZATION_CHALLENGE_SCHEMA.optional(),
  description: z.string(),
  name: z.string(),
  webhookUrl: z.url().optional(),
});

// Bounds on caller-supplied text. The transport already caps the whole body
// at MCP_REQUEST_BODY_MAX_BYTES; these keep individual durable fields sane.
// Text bounds are UTF-8 bytes, matching the transport cap and the docs;
// string.length undercounts multibyte input by up to 3x.
const MAX_MESSAGE_BYTES = 64 * 1_024;
const MAX_RESPONSE_TEXT_BYTES = 16 * 1_024;
const MAX_ID_CHARS = 256;
const MAX_RESPONSES_PER_UPDATE = 64;

function utf8Bounded(maxBytes: number) {
  const encoder = new TextEncoder();
  return z.string().refine((value) => encoder.encode(value).byteLength <= maxBytes, {
    message: `must be at most ${String(maxBytes)} bytes when UTF-8 encoded`,
  });
}

const MCP_INPUT_RESPONSE_SCHEMA = inputResponseSchema.safeExtend({
  optionId: z.string().max(MAX_ID_CHARS).optional(),
  requestId: z.string().min(1).max(MAX_ID_CHARS),
  text: utf8Bounded(MAX_RESPONSE_TEXT_BYTES).optional(),
});

const MCP_INPUT_REQUEST_SCHEMA = inputRequestSchema.safeExtend({
  action: z.strictObject({
    callId: z.string(),
    input: z.record(z.string(), z.json()),
    kind: z.literal("tool-call"),
    toolName: z.string(),
  }),
});

const AGENT_INVOCATION_BASE_SCHEMA = z.strictObject({
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().optional(),
  invocationId: z.string(),
});

const AGENT_INVOCATION_OUTPUT_SCHEMA = z.discriminatedUnion("status", [
  AGENT_INVOCATION_BASE_SCHEMA.extend({
    pollAfterMs: z.number().int().nonnegative(),
    result: z.json().optional(),
    status: z.literal("working"),
  }),
  AGENT_INVOCATION_BASE_SCHEMA.extend({
    inputRequests: z.record(z.string(), MCP_INPUT_REQUEST_SCHEMA),
    result: z.json().optional(),
    status: z.literal("input_required"),
  }),
  AGENT_INVOCATION_BASE_SCHEMA.extend({
    authorizations: z.array(AUTHORIZATION_REQUEST_SCHEMA).min(1),
    pollAfterMs: z.number().int().nonnegative(),
    result: z.json().optional(),
    status: z.literal("authorization_required"),
  }),
  AGENT_INVOCATION_BASE_SCHEMA.extend({
    result: z.json().optional(),
    status: z.literal("completed"),
  }),
  AGENT_INVOCATION_BASE_SCHEMA.extend({
    error: z.strictObject({
      code: z.number().int(),
      data: z.json().optional(),
      message: z.string(),
    }),
    status: z.literal("failed"),
  }),
  AGENT_INVOCATION_BASE_SCHEMA.extend({ status: z.literal("cancelled") }),
]);
