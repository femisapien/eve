/**
 * Slack Web API transport: bot-token resolution, the endpoint every
 * outbound call is aimed at, the fetch that traffic uses, and the base
 * an authenticated attachment download may come from.
 *
 * Separate from `api.ts` to keep that file under the 700-line cap
 * `internal/structural-tests/file-length.test.ts` enforces.
 */

import {
  resolveSlackBotToken as resolveSlackBotTokenPrimitive,
  type SlackApiOptions as SlackPrimitiveApiOptions,
  type SlackApiResponse as SlackPrimitiveApiResponse,
} from "#compiled/@chat-adapter/slack/api.js";

import { callSlackApiTrackingResponse } from "#public/channels/slack/api-errors.js";

/** Fetch implementation used for Slack traffic. */
export type SlackFetch = typeof globalThis.fetch;

/** Slack's own Web API base, used when `apiBaseUrl` is not set. */
export const SLACK_API_BASE_URL = "https://slack.com/api/";

/**
 * Slack API transport overrides. `apiBaseUrl` defaults to
 * `https://slack.com/api/`, `fileBaseUrl` falls back to `apiBaseUrl`,
 * and `fetch` defaults to the global `fetch`.
 */
export interface SlackApiOptions {
  /** Base every Slack Web API method name is resolved against. */
  readonly apiBaseUrl?: string;
  /**
   * Base an authenticated attachment download may come from, in
   * addition to Slack's own file hosts. Falls back to `apiBaseUrl`.
   */
  readonly fileBaseUrl?: string;
  /**
   * Replaces the global `fetch` for requests to `apiBaseUrl` and to
   * `fileBaseUrl`. Every other host — Slack's CDN, the upload host
   * `files.getUploadURLExternal` names — keeps the global `fetch`.
   */
  readonly fetch?: SlackFetch;
}

/**
 * Normalizes a Slack base URL.
 *
 * A trailing slash is added because both uses need one: Slack method
 * names are appended by relative URL resolution, which keeps only the
 * origin and the directory part of the path, and a download URL is
 * matched against `fileBaseUrl` as a prefix. A query or fragment is
 * rejected for the same reason — neither survives either operation.
 */
function normalizeSlackBaseUrl(field: "apiBaseUrl" | "fileBaseUrl", base: string): string {
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(
      `Slack api.${field} must be a valid absolute URL, received ${JSON.stringify(base)}. ` +
        `Set a full URL such as "http://localhost:3000/api/slack".`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Slack api.${field} must be an http: or https: URL, received ${JSON.stringify(base)}.`,
    );
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      `Slack api.${field} must not carry a query string or fragment, received ${JSON.stringify(base)}. ` +
        `Only the origin and the directory part of the path are used, so anything after them would be dropped.`,
    );
  }
  if (!parsed.pathname.endsWith("/")) parsed.pathname = `${parsed.pathname}/`;
  return parsed.toString();
}

/** Resolves the Slack Web API base, defaulting to Slack's own host. */
export function resolveSlackApiBaseUrl(api?: SlackApiOptions): string {
  return normalizeSlackBaseUrl("apiBaseUrl", api?.apiBaseUrl ?? SLACK_API_BASE_URL);
}

/**
 * Resolves the attachment-download base, falling back to `apiBaseUrl`.
 *
 * `undefined` when neither is configured: the carve-out exists so a
 * Slack-compatible stand-in can serve its own files, and with no base
 * configured there is no stand-in. Slack's own file hosts are allowed
 * by hostname, not by this base.
 */
export function resolveSlackFileBaseUrl(api?: SlackApiOptions): string | undefined {
  if (api?.fileBaseUrl !== undefined) return normalizeSlackBaseUrl("fileBaseUrl", api.fileBaseUrl);
  if (api?.apiBaseUrl !== undefined) return normalizeSlackBaseUrl("apiBaseUrl", api.apiBaseUrl);
  return undefined;
}

/** Slack app installation workspace available when eve resolves a bot token. */
export interface SlackBotTokenContext {
  readonly teamId?: string;
}

/**
 * Slack bot token, materialized either as a literal `xoxb-...` string or
 * as a (possibly async) function that receives the app installation workspace.
 */
export type SlackBotToken = string | ((context: SlackBotTokenContext) => string | Promise<string>);

/**
 * Materializes a {@link SlackBotToken} to a string, falling back to
 * `process.env.SLACK_BOT_TOKEN`. Throws when neither is set.
 */
export async function resolveSlackBotToken(
  token?: SlackBotToken,
  context: SlackBotTokenContext = {},
): Promise<string> {
  const source = token ?? process.env.SLACK_BOT_TOKEN;
  if (!source) throw new Error("SLACK_BOT_TOKEN is required.");
  if (typeof source === "function") return source(context);
  return resolveSlackBotTokenPrimitive(source);
}

/**
 * Slack Web API JSON response envelope. `ok` signals success, `error`
 * carries Slack's error code on failure, and method-specific fields pass
 * through verbatim. Callers inspect `ok` themselves.
 */
export type SlackApiResponse = SlackPrimitiveApiResponse;

/**
 * A Slack Web API caller bound to a transport, with the app installation
 * workspace supplied per call.
 */
export type SlackApiCaller = (
  operation: string,
  body: Record<string, unknown>,
  context?: SlackBotTokenContext,
) => Promise<SlackApiResponse>;

/**
 * The channel's Slack Web API transport: a bot token, an endpoint, and a
 * fetch, resolved once and carried as one opaque value.
 *
 * Every builder that outlives a request takes one of these rather than a
 * `botToken` plus an `api` option bag. There is then no second parameter
 * for a call site to forget, so no handle can be constructed that talks
 * to real Slack with the real token while the rest of the channel talks
 * to a stand-in.
 */
export interface SlackTransport {
  /** POSTs to a Slack Web API method through this transport. */
  readonly call: SlackApiCaller;

  /**
   * Transport options for the vendored Slack helpers, scoped to one
   * installation workspace.
   */
  options(context?: SlackBotTokenContext): SlackPrimitiveApiOptions;

  /** Materializes the bot token for one installation workspace. */
  resolveToken(context?: SlackBotTokenContext): Promise<string>;

  /**
   * Materializes the bot token up front and returns a caller bound to
   * it, so a throwing token resolver surfaces at the bind rather than
   * from inside the call.
   */
  bindToken(
    context?: SlackBotTokenContext,
  ): Promise<(operation: string, body: Record<string, unknown>) => Promise<SlackApiResponse>>;

  /**
   * The fetch an authenticated download of `url` should use, or
   * `undefined` when `url` is not served by the configured file base.
   */
  downloadFetch(url: string): SlackFetch | undefined;
}

/** Builds the {@link SlackTransport} a channel funnels every call through. */
export function createSlackTransport(input: {
  readonly api?: SlackApiOptions;
  readonly botToken?: SlackBotToken;
}): SlackTransport {
  const apiBaseUrl = resolveSlackApiBaseUrl(input.api);
  const fileBaseUrl = resolveSlackFileBaseUrl(input.api);
  const apiFetch = scopeFetchToOrigin(input.api?.fetch, new URL(apiBaseUrl).origin);

  const options = (context: SlackBotTokenContext = {}): SlackPrimitiveApiOptions => ({
    apiUrl: apiBaseUrl,
    fetch: apiFetch,
    token: () => resolveSlackBotToken(input.botToken, context),
  });

  return {
    call: (operation, body, context) =>
      callSlackApiTrackingResponse(operation, body, options(context)),
    options,
    resolveToken: (context = {}) => resolveSlackBotToken(input.botToken, context),
    async bindToken(context = {}) {
      const token = await resolveSlackBotToken(input.botToken, context);
      return (operation, body) =>
        callSlackApiTrackingResponse(operation, body, { ...options(), token });
    },
    downloadFetch(url) {
      if (fileBaseUrl === undefined) return undefined;
      // Prefix, not origin: a download URL arrives in an inbound webhook
      // payload, so the narrower match is what keeps an `apiBaseUrl` of
      // `https://slack.com/api/` from turning every `https://slack.com/…`
      // link into a bot-token-authenticated fetch. Comparing the parsed
      // `href` is what makes `…/files/../secret` fail to match.
      const parsed = URL.parse(url);
      if (parsed === null || !parsed.href.startsWith(fileBaseUrl)) return undefined;
      return input.api?.fetch ?? globalThis.fetch;
    },
  };
}

/**
 * Low-level POST to a Slack Web API method, signed with the bot token
 * and form-encoded. Form is the only safe default: Slack's JSON support
 * is partial (e.g. `conversations.replies` rejects JSON). Returns the
 * raw JSON response; callers inspect `response.ok` themselves.
 *
 * The escape hatch for code holding a bare token rather than a channel.
 * Pass the same `api` the channel was given, or the call goes to
 * `https://slack.com/api/`.
 */
export async function callSlackApi(input: {
  readonly api?: SlackApiOptions;
  readonly botToken: SlackBotToken | undefined;
  readonly context?: SlackBotTokenContext;
  readonly operation: string;
  readonly body: object;
}): Promise<SlackApiResponse> {
  const transport = createSlackTransport({ api: input.api, botToken: input.botToken });
  return transport.call(input.operation, asSlackApiBody(input.body), input.context);
}

/**
 * Widens a caller's payload to the encoder's parameter type. The public
 * surface takes `object` so an `interface`-typed payload — which has no
 * implicit index signature — is accepted; the encoder only ever reads
 * the payload's own entries.
 */
export function asSlackApiBody(body: object): Record<string, unknown> {
  return body as Record<string, unknown>;
}

/**
 * Confines a caller-supplied `fetch` to one origin, so a wrapper that
 * attaches stand-in credentials cannot carry them to a host the
 * stand-in merely named. `files.getUploadURLExternal` answers with an
 * `upload_url` of the server's choosing, and the vendored upload helper
 * POSTs the bytes to it with this same fetch.
 */
function scopeFetchToOrigin(
  custom: SlackFetch | undefined,
  origin: string,
): SlackFetch | undefined {
  // Left unset rather than defaulted to `globalThis.fetch`, so the
  // vendored helpers keep reading the global at call time.
  if (custom === undefined) return undefined;
  return (target, init) =>
    requestOrigin(target) === origin ? custom(target, init) : globalThis.fetch(target, init);
}

function requestOrigin(target: unknown): string | undefined {
  const href =
    typeof target === "object" &&
    target !== null &&
    "url" in target &&
    typeof target.url === "string"
      ? target.url
      : String(target);
  return URL.parse(href)?.origin;
}
