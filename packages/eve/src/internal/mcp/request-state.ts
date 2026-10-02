import { createHash, randomBytes } from "node:crypto";

import {
  createRequestStateCodec,
  type McpRequestHandlerExtra,
  type RequestStateCodec,
} from "#compiled/@modelcontextprotocol/server/index.js";

import { EVE_DEV_ENV_FLAG } from "#internal/application/dev-environment.js";

/** Environment variable holding the deployment's MCP `requestState` HMAC secret. */
export const MCP_REQUEST_STATE_SECRET_ENV = "EVE_MCP_REQUEST_STATE_SECRET";

/** Shortest accepted secret, in UTF-8 bytes. The SDK codec enforces the same floor. */
export const MCP_REQUEST_STATE_SECRET_MIN_BYTES = 32;

/** How long a minted `requestState` stays valid. */
export const MCP_REQUEST_STATE_TTL_SECONDS = 600;

/**
 * What eve signs into an MCP `requestState`. The client can read it (the codec
 * signs, it does not encrypt), so it holds no secrets: the session id is a
 * hash, the arguments are a hash, and the one-off nonce only names a sandbox
 * the same principals can already reach.
 *
 * A valid signature grants nothing by itself. It proves eve minted this state
 * for this tool, these arguments, and this session; core still re-evaluates
 * approval and re-derives the session on every call.
 */
export interface McpRequestStatePayload {
  readonly v: 1;
  /** Which round minted the state: an approval question or a sign-in. */
  readonly kind: "approval" | "authorization";
  readonly callId: string;
  /** The tool session id derived from the minting request's principals and key or nonce. */
  readonly sid: string;
  readonly tool: string;
  /** {@link hashToolArguments} of the minting request's arguments. */
  readonly args: string;
  /** The one-off nonce, present when the call carried no tool session key. */
  readonly nonce?: string;
  /** The person's approval answer, carried into a sign-in round that follows it. */
  readonly approval?: { readonly approved: boolean };
  /**
   * The URLs an `authorization` round asked the person to open, so a retry
   * that leaves one unanswered gets the same URLs back without running the
   * tool again. They already went to the client in `inputRequests`.
   */
  readonly authorizationUrls?: readonly McpAuthorizationUrl[];
}

/** One URL an `authorization` round asks the person to open to sign in to a connection. */
export interface McpAuthorizationUrl {
  /** The connection name; the input request key is `dev.eve/authorization:<connection>`. */
  readonly connection: string;
  readonly url: string;
  readonly userCode?: string;
}

/** A resolved deployment secret, or why there is none. */
export type McpRequestStateSecret =
  | { readonly kind: "configured"; readonly key: string }
  | { readonly kind: "development"; readonly key: Uint8Array }
  | { readonly kind: "missing"; readonly reason: string };

let developmentKey: Uint8Array | undefined;

/**
 * Resolves the `requestState` secret: the channel option, else
 * {@link MCP_REQUEST_STATE_SECRET_ENV}. Throws when the option is too short,
 * since that is an authoring error. A too-short environment value is reported
 * as missing so plain tools keep working while stateful ones fail loudly.
 * During `eve dev` a missing secret falls back to a per-process random key,
 * which is enough because one process serves every round there.
 */
export function resolveMcpRequestStateSecret(
  option: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): McpRequestStateSecret {
  if (option !== undefined) {
    const problem = secretProblem(option);
    if (problem !== undefined) throw new Error(`mcpChannel requestStateSecret ${problem}`);
    return { key: option, kind: "configured" };
  }
  const fromEnv = env[MCP_REQUEST_STATE_SECRET_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    const problem = secretProblem(fromEnv);
    if (problem === undefined) return { key: fromEnv, kind: "configured" };
    return { kind: "missing", reason: `${MCP_REQUEST_STATE_SECRET_ENV} ${problem}` };
  }
  if (isDevelopment(env)) {
    developmentKey ??= new Uint8Array(randomBytes(32));
    return { key: developmentKey, kind: "development" };
  }
  return {
    kind: "missing",
    reason: `Set ${MCP_REQUEST_STATE_SECRET_ENV} (at least ${MCP_REQUEST_STATE_SECRET_MIN_BYTES} bytes, the same value on every instance) so MCP calls can ask for approval or sign-in.`,
  };
}

function secretProblem(secret: string): string | undefined {
  const bytes = Buffer.byteLength(secret, "utf8");
  if (bytes >= MCP_REQUEST_STATE_SECRET_MIN_BYTES) return undefined;
  return `must be at least ${MCP_REQUEST_STATE_SECRET_MIN_BYTES} bytes (got ${bytes}).`;
}

function isDevelopment(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[EVE_DEV_ENV_FLAG] === "1" || env.NODE_ENV === "development";
}

/** Mints and verifies eve's MCP `requestState`. */
export interface McpRequestStateCodec {
  mint(payload: McpRequestStatePayload): Promise<string>;
  /**
   * Verifies the MAC and expiry, then the payload shape. Throws on any
   * failure; pass it as `ServerOptions.requestState.verify` so the SDK answers
   * the client's `-32602`.
   */
  verify(state: string, ctx: McpRequestHandlerExtra): Promise<McpRequestStatePayload>;
}

/** Builds the HMAC-SHA256 codec over a deployment secret. */
export function createMcpRequestStateCodec(key: string | Uint8Array): McpRequestStateCodec {
  const codec: RequestStateCodec<unknown> = createRequestStateCodec<unknown>({
    key,
    ttlSeconds: MCP_REQUEST_STATE_TTL_SECONDS,
  });
  return {
    async mint(payload) {
      return await codec.mint(payload);
    },
    async verify(state, ctx) {
      const payload = await codec.verify(state, ctx);
      if (!isRequestStatePayload(payload)) throw new Error("malformed");
      return payload;
    },
  };
}

function isRequestStatePayload(value: unknown): value is McpRequestStatePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  if (payload.v !== 1) return false;
  if (payload.kind !== "approval" && payload.kind !== "authorization") return false;
  for (const field of ["callId", "sid", "tool", "args"] as const) {
    if (typeof payload[field] !== "string" || payload[field].length === 0) return false;
  }
  if (payload.nonce !== undefined && typeof payload.nonce !== "string") return false;
  if (payload.approval !== undefined) {
    const approval = payload.approval as Record<string, unknown> | null;
    if (typeof approval !== "object" || approval === null) return false;
    if (typeof approval.approved !== "boolean") return false;
  }
  if (payload.kind === "authorization") {
    const urls = payload.authorizationUrls;
    if (!Array.isArray(urls) || urls.length === 0 || !urls.every(isAuthorizationUrl)) return false;
  } else if (payload.authorizationUrls !== undefined) {
    return false;
  }
  return true;
}

function isAuthorizationUrl(value: unknown): value is McpAuthorizationUrl {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.connection !== "string" || entry.connection.length === 0) return false;
  if (typeof entry.url !== "string" || entry.url.length === 0) return false;
  return entry.userCode === undefined || typeof entry.userCode === "string";
}

/** `sha256` (hex) of the canonical JSON of a call's arguments. */
export function hashToolArguments(args: unknown): string {
  return createHash("sha256").update(canonicalJson(args), "utf8").digest("hex");
}

/**
 * JSON with object keys sorted at every depth, so two encodings of the same
 * arguments hash the same. `undefined` members are dropped, as JSON does.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(",")}}`;
}
