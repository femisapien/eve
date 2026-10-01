import { resolveForwardedPrincipal, type TrustedForwarders } from "#channel/forwarded-principal.js";
import type { SessionAuthContext } from "#channel/types.js";

/** Request header carrying a forwarded principal on MCP requests. */
export const MCP_FORWARDED_PRINCIPAL_HEADER = "eve-forwarded-principal";

/** Largest accepted encoded header value. */
export const MCP_FORWARDED_PRINCIPAL_HEADER_MAX_BYTES = 16 * 1024;

const BASE64URL_UNPADDED = /^[A-Za-z0-9_-]*$/;

/** The principals one MCP request acts as. */
export interface McpRequestPrincipals {
  /** The caller: the route-auth principal, or the accepted forwarded `current`. */
  readonly current: SessionAuthContext;
  /** The accepted forwarded initiator (`current` when the forwarder omitted it). */
  readonly initiator?: SessionAuthContext;
  /** The route-auth principal that forwarded `current`, when one was accepted. */
  readonly forwarder?: SessionAuthContext;
}

/**
 * Resolves the `eve-forwarded-principal` header against the channel's
 * `trustedForwarders`, sharing parsing, stamping, and the predicate with
 * eveChannel's `forwardedPrincipal` body field.
 *
 * Without a predicate the header is ignored entirely. With one, a malformed or
 * oversized header is a 400 and a refused forwarder a 403, before any MCP
 * handling. An anonymous route principal (`none()`) cannot forward: there is
 * no one to hold accountable for the assertion, so the request is refused.
 */
export async function resolveMcpRequestPrincipals(
  request: Request,
  routePrincipal: SessionAuthContext,
  trustedForwarders: TrustedForwarders | undefined,
): Promise<McpRequestPrincipals | Response> {
  const header = request.headers.get(MCP_FORWARDED_PRINCIPAL_HEADER);
  if (header === null || trustedForwarders === undefined) return { current: routePrincipal };

  if (routePrincipal.principalType === "anonymous") {
    return forwardedHeaderFailure(
      403,
      "An anonymous caller cannot forward a principal. Authenticate the forwarder.",
    );
  }
  const decoded = decodeForwardedPrincipalHeader(header);
  if (!decoded.ok) return forwardedHeaderFailure(400, decoded.message);

  const resolved = await resolveForwardedPrincipal({
    forwarder: routePrincipal,
    payload: { forwardedPrincipal: decoded.value },
    trustedForwarders,
  });
  if (resolved instanceof Response) return resolved;
  if (!resolved.accepted) return { current: routePrincipal };
  return { current: resolved.auth, forwarder: routePrincipal, initiator: resolved.initiatorAuth };
}

/** Decodes the header: unpadded base64url of UTF-8 JSON, at most 16 KiB encoded. */
export function decodeForwardedPrincipalHeader(
  value: string,
):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string } {
  if (value.length > MCP_FORWARDED_PRINCIPAL_HEADER_MAX_BYTES) {
    return {
      message: `The ${MCP_FORWARDED_PRINCIPAL_HEADER} header must be at most ${MCP_FORWARDED_PRINCIPAL_HEADER_MAX_BYTES} bytes.`,
      ok: false,
    };
  }
  if (value.length === 0 || !BASE64URL_UNPADDED.test(value) || value.length % 4 === 1) {
    return {
      message: `The ${MCP_FORWARDED_PRINCIPAL_HEADER} header must be unpadded base64url.`,
      ok: false,
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(value, "base64url"));
  } catch {
    return {
      message: `The ${MCP_FORWARDED_PRINCIPAL_HEADER} header must encode UTF-8 JSON.`,
      ok: false,
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      message: `The ${MCP_FORWARDED_PRINCIPAL_HEADER} header must encode UTF-8 JSON.`,
      ok: false,
    };
  }
}

/** Encodes a forwarded principal for the header. */
export function encodeForwardedPrincipalHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function forwardedHeaderFailure(status: 400 | 403, error: string): Response {
  return Response.json({ error, ok: false }, { status });
}
