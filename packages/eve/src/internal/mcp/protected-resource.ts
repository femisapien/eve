import { validateMcpMetadataRequest } from "#internal/mcp/http-security.js";
import { escapeAuthChallengeParameter, type OAuthResourceOptions } from "#public/channels/auth.js";

interface McpProtectedResourceMetadataOptions {
  readonly authorizationServers: readonly string[];
  readonly resource: string;
  readonly scopesSupported?: readonly string[];
}

/** Creates RFC 9728 protected-resource metadata for an MCP endpoint. */
export function createMcpProtectedResourceMetadata(
  options: McpProtectedResourceMetadataOptions,
): Readonly<Record<string, unknown>> {
  const metadata: Record<string, unknown> = {
    authorization_servers: options.authorizationServers,
    resource: options.resource,
  };
  if (options.scopesSupported !== undefined) {
    metadata.scopes_supported = options.scopesSupported;
  }
  return metadata;
}

/** Creates the RFC 9728 bearer discovery challenge for an MCP resource. */
export function createMcpResourceChallenge(
  resourceMetadataUrl: string,
  scopes?: readonly string[],
): string {
  const parameters = [`resource_metadata="${escapeAuthChallengeParameter(resourceMetadataUrl)}"`];
  if (scopes?.length) {
    parameters.push(`scope="${escapeAuthChallengeParameter(scopes.join(" "))}"`);
  }
  return `Bearer ${parameters.join(", ")}`;
}

export function protectedResourceMetadataPath(
  options: OAuthResourceOptions,
  resourcePath: string,
): string {
  if (options.metadataPath !== undefined) return options.metadataPath;
  const path = options.resource === undefined ? resourcePath : new URL(options.resource).pathname;
  return path === "/"
    ? "/.well-known/oauth-protected-resource"
    : `/.well-known/oauth-protected-resource${path}`;
}

export function protectedResourceMetadataResponse(
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

export function protectedResourceMetadataOptionsResponse(request: Request): Response {
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

export function addResourceChallenge(
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
