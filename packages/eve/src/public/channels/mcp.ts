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
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { createLogger, logError } from "#internal/logging.js";
import {
  resolveMcpRequestPrincipals,
  type McpRequestPrincipals,
} from "#internal/mcp/forwarded-principal-header.js";
import { createMcpSkillsFeature } from "#internal/mcp/skills.js";
import { validateMcpHttpRequest, validateMcpMetadataRequest } from "#internal/mcp/http-security.js";
import {
  createMcpRequestStateCodec,
  resolveMcpRequestStateSecret,
  type McpRequestStateCodec,
} from "#internal/mcp/request-state.js";
import {
  createMcpStreamableHttpServer,
  type McpServerFeature,
} from "#internal/mcp/streamable-http-server.js";
import {
  MCP_TOOLS_CAPABILITIES,
  registerMcpTools,
  type McpToolsRequestState,
} from "#internal/mcp/tools.js";
import {
  createMcpProtectedResourceMetadata,
  createMcpResourceChallenge,
} from "#internal/mcp/protected-resource.js";
import {
  escapeAuthChallengeParameter,
  readOAuthResourceOptions,
  routeAuth,
  type AuthFn,
  type OAuthResourceOptions,
} from "#public/channels/auth.js";

export type { ForwardedAssertion, TrustedForwarders } from "#channel/forwarded-principal.js";

const log = createLogger("mcp.channel");

export interface McpChannelInput {
  /** Existing eve route-auth policy. Use `none()` for explicit public access. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** Override the default MCP route path (`/eve/v1/mcp`). */
  readonly route?: string;
  /**
   * Publish the agent's invocable tools over `tools/list` and `tools/call`.
   * Defaults to `true`. `false` removes the `tools` capability and the
   * `dev.eve/tool-sessions` extension from `server/discover`.
   */
  readonly tools?: boolean;
  /** Publish the agent's skills. Defaults to `true`. */
  readonly skills?: boolean;
  /**
   * Accepts the `eve-forwarded-principal` header from route-authenticated
   * forwarders this predicate trusts, the way `eveChannel` accepts its
   * `forwardedPrincipal` body field. Without it the header is ignored.
   */
  readonly trustedForwarders?: TrustedForwarders;
  /**
   * HMAC secret for the `requestState` of approval and sign-in rounds, at
   * least 32 bytes and the same on every instance. Defaults to
   * `EVE_MCP_REQUEST_STATE_SECRET`. During `eve dev` a per-process random key
   * is used when neither is set.
   */
  readonly requestStateSecret?: string;
}

/** Public MCP channel publishing this agent as an MCP server. */
export type McpChannel = Channel;

/**
 * `ttlMs` / `cacheScope` for the lists eve builds. They are fixed per
 * deployment and identical for every admitted caller, so a client may reuse
 * them for a while. `private` because the response sits behind route auth: a
 * shared cache cannot re-run that auth for the next caller.
 */
const MCP_LIST_CACHE_HINT = { cacheScope: "private", ttlMs: 5 * 60 * 1000 } as const;

interface McpChannelConfig {
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
 * This channel owns MCP transport and authentication. It reuses eve's inbound
 * auth strategies and recognizes `oauthResource(...)` metadata when OAuth
 * discovery is needed. It publishes the agent's invocable tools (each call
 * runs through `invokeTool` in a tool session) and its skills.
 * The file containing this channel must be `agent/channels/mcp.ts`.
 */
export function mcpChannel(input: McpChannelInput): McpChannel {
  if (input?.auth === undefined) {
    throw new Error("mcpChannel requires auth. Use none() for explicit public access.");
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
    auth: input.auth,
    oauth,
    requestState() {
      requestState ??= toRequestState(optionSecret ?? resolveMcpRequestStateSecret(undefined));
      return requestState;
    },
    skills: input.skills ?? true,
    tools: input.tools ?? true,
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

function protectedResourceMetadataPath(
  options: OAuthResourceOptions,
  resourcePath: string,
): string {
  if (options.metadataPath !== undefined) return options.metadataPath;
  const path = options.resource === undefined ? resourcePath : new URL(options.resource).pathname;
  return path === "/"
    ? "/.well-known/oauth-protected-resource"
    : `/.well-known/oauth-protected-resource${path}`;
}

function protectedResourceMetadataResponse(
  request: Request,
  options: OAuthResourceOptions,
  resourcePath: string,
  head: boolean,
): Response {
  const securityFailure = validateMcpMetadataRequest(request);
  if (securityFailure !== undefined) return securityFailure;
  const resource =
    options.resource ?? new URL(resourcePath, new URL(request.url).origin).toString();
  const authorizationServers =
    options.issuer !== undefined ? [options.issuer] : options.authorizationServers;
  const response = Response.json(
    createMcpProtectedResourceMetadata({
      authorizationServers,
      resource,
      scopesSupported: options.scopes,
    }),
    {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
      },
    },
  );
  return head
    ? new Response(null, { headers: response.headers, status: response.status })
    : response;
}

function protectedResourceMetadataOptionsResponse(request: Request): Response {
  const securityFailure = validateMcpMetadataRequest(request);
  if (securityFailure !== undefined) return securityFailure;
  const headers = new Headers({
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  const requestedHeaders = request.headers.get("access-control-request-headers");
  if (requestedHeaders !== null) {
    headers.set("access-control-allow-headers", requestedHeaders);
    headers.set("vary", "Access-Control-Request-Headers");
  }
  return new Response(null, { headers, status: 204 });
}

function addResourceChallenge(
  response: Response,
  request: Request,
  options: OAuthResourceOptions,
): Response {
  if (response.status !== 401 && response.status !== 403) return response;
  const metadataPath = protectedResourceMetadataPath(options, new URL(request.url).pathname);
  const publicBase = options.resource ?? new URL(request.url).origin;
  const metadataUrl = new URL(metadataPath, publicBase).toString();
  const headers = new Headers(response.headers);
  const existing = headers.get("www-authenticate");
  if (response.status === 401) {
    headers.set("www-authenticate", mergeMcpBearerChallenge(existing, metadataUrl, options.scopes));
  } else {
    const challenge = augmentInsufficientScopeChallenge(existing, metadataUrl);
    if (challenge === undefined) return response;
    headers.set("www-authenticate", challenge);
  }
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

interface ParsedAuthChallenge {
  readonly scheme: string;
  readonly value: string;
}

function mergeMcpBearerChallenge(
  header: string | null,
  metadataUrl: string,
  scopes: readonly string[] | undefined,
): string {
  const challenges = parseAuthChallenges(header);
  const bearer =
    challenges.find(
      (challenge) =>
        challenge.scheme.toLowerCase() === "bearer" && hasAuthParameter(challenge.value, "error"),
    ) ?? challenges.find((challenge) => challenge.scheme.toLowerCase() === "bearer");
  const canonical =
    bearer === undefined
      ? createMcpResourceChallenge(metadataUrl, scopes)
      : augmentBearerChallenge(bearer.value, metadataUrl, scopes);
  return replaceBearerChallenges(challenges, bearer, canonical);
}

function augmentInsufficientScopeChallenge(
  header: string | null,
  metadataUrl: string,
): string | undefined {
  const challenges = parseAuthChallenges(header);
  const bearer = challenges.find(
    (challenge) =>
      challenge.scheme.toLowerCase() === "bearer" &&
      hasAuthParameter(challenge.value, "error", "insufficient_scope"),
  );
  if (bearer === undefined) return undefined;
  return replaceBearerChallenges(
    challenges,
    bearer,
    augmentBearerChallenge(bearer.value, metadataUrl),
  );
}

function replaceBearerChallenges(
  challenges: readonly ParsedAuthChallenge[],
  selected: ParsedAuthChallenge | undefined,
  replacement: string,
): string {
  const result: string[] = [];
  let inserted = false;
  for (const challenge of challenges) {
    if (challenge.scheme.toLowerCase() !== "bearer") {
      result.push(challenge.value);
      continue;
    }
    if (!inserted && challenge === selected) {
      result.push(replacement);
      inserted = true;
    }
  }
  if (!inserted) result.push(replacement);
  return result.join(", ");
}

function augmentBearerChallenge(
  challenge: string,
  metadataUrl: string,
  scopes?: readonly string[],
): string {
  let result = challenge;
  if (!hasAuthParameter(result, "resource_metadata")) {
    result = appendAuthParameter(result, "resource_metadata", metadataUrl);
  }
  if (scopes?.length && !hasAuthParameter(result, "scope")) {
    result = appendAuthParameter(result, "scope", scopes.join(" "));
  }
  return result;
}

function appendAuthParameter(challenge: string, name: string, value: string): string {
  const separator = challenge.trim().toLowerCase() === "bearer" ? " " : ", ";
  return `${challenge}${separator}${name}="${escapeAuthChallengeParameter(value)}"`;
}

function hasAuthParameter(challenge: string, name: string, value?: string): boolean {
  const escapedName = name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (value === undefined) {
    return new RegExp(`(?:^|[\\s,])${escapedName}\\s*=`, "i").test(challenge);
  }
  const escapedValue = value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[\\s,])${escapedName}\\s*=\\s*(?:"${escapedValue}"|${escapedValue})(?=$|[\\s,])`,
    "i",
  ).test(challenge);
}

function parseAuthChallenges(header: string | null): readonly ParsedAuthChallenge[] {
  if (header === null) return [];
  const challenges: Array<{ scheme: string; value: string }> = [];
  for (const part of splitQuotedHeaderList(header)) {
    const scheme = readChallengeScheme(part);
    if (scheme !== undefined) {
      challenges.push({ scheme, value: part });
      continue;
    }
    const current = challenges.at(-1);
    if (current !== undefined) current.value += `, ${part}`;
  }
  return challenges;
}

function splitQuotedHeaderList(header: string): readonly string[] {
  const parts: string[] = [];
  let escaped = false;
  let quoted = false;
  let start = 0;
  for (let index = 0; index < header.length; index++) {
    const character = header[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      const part = header.slice(start, index).trim();
      if (part.length > 0) parts.push(part);
      start = index + 1;
    }
  }
  const last = header.slice(start).trim();
  if (last.length > 0) parts.push(last);
  return parts;
}

function readChallengeScheme(value: string): string | undefined {
  const match = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+)(?:\s+|$)/.exec(value);
  if (match === null) return undefined;
  const scheme = match[1];
  if (scheme === undefined) return undefined;
  return value.slice(scheme.length).trimStart().startsWith("=") ? undefined : scheme;
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
          tools: description.tools,
        });
      },
    });
  }
  // The SEP-2640 skills module plugs in here as another feature when
  // `config.skills` is on: `skills/list`, `skills/get`, `resources/read`,
  // `resources/directory/read`, the `resources` capability, and the
  // `io.modelcontextprotocol/skills` extension.
  features.push(...skillsFeatures(config, description, args));

  return await createMcpStreamableHttpServer<McpRequestPrincipals>({
    authenticate: async () => principals,
    cacheHints: { "server/discover": MCP_LIST_CACHE_HINT, "tools/list": MCP_LIST_CACHE_HINT },
    features,
    listen: "ack-then-close",
    name: description.name,
    requestState: {
      async verify(state, ctx) {
        // No secret means eve never minted a state: nothing echoed can verify.
        if (requestState?.kind !== "codec") throw new Error("no requestState secret");
        return await requestState.codec.verify(state, ctx);
      },
    },
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
