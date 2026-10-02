import {
  createMcpHandler,
  McpServer,
  type CacheableResultMethod,
  type CacheHint,
  type McpJsonObject,
  type McpRequestHandlerExtra,
  type McpServerOptions,
  type McpToolAnnotations,
  type StandardSchemaWithJSON,
} from "#compiled/@modelcontextprotocol/server/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("mcp.server");

export const MCP_PROTOCOL_VERSION = "2026-07-28";
/**
 * Upper bound for any MCP POST body. Tool arguments are small JSON; the
 * largest legitimate payload is an `outputSchema`, itself capped at 64 KiB.
 */
export const MCP_REQUEST_BODY_MAX_BYTES = 1024 * 1024;

/**
 * Cache hint for the tool lists, skill lists, and skill reads eve builds.
 * They are fixed per deployment, but clients cache per URL, and a production
 * alias serves a new deployment's lists under the same URL. So the TTL is how
 * long a client may see the old lists after a deploy. `private`: route auth
 * admitted this caller, and a shared cache cannot rerun it for the next one.
 */
export const MCP_LIST_CACHE_HINT = {
  cacheScope: "private",
  ttlMs: 5 * 60 * 1000,
} as const satisfies CacheHint;

export interface McpToolDefinition<
  TInputSchema extends StandardSchemaWithJSON = StandardSchemaWithJSON,
> {
  readonly name: string;
  readonly description?: string;
  readonly annotations?: McpToolAnnotations;
  readonly inputSchema: TInputSchema;
  readonly outputSchema?: StandardSchemaWithJSON;
}

export interface McpCallToolResult<
  TStructured extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly content: readonly McpContent[];
  readonly isError?: boolean;
  readonly structuredContent?: TStructured | McpToolOperationErrorEnvelope;
}

export interface McpToolOperationErrorEnvelope {
  readonly error: McpToolOperationErrorData;
}

export type McpContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resource_link"; readonly name: string; readonly uri: string };

/**
 * Stable, client-actionable reason a tool call was rejected before it could
 * return a result. `invalid_input` and `conflict` mean the caller should
 * change or re-read something; `not_found` means stop; `internal` means the
 * server failed and `errorId` correlates with its logs.
 */
type McpToolOperationErrorCode = "invalid_input" | "not_found" | "conflict" | "internal";

interface McpToolOperationErrorData {
  readonly code: McpToolOperationErrorCode;
  readonly errorId?: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** Thrown by tool handlers to produce a structured `isError` result. */
export class McpToolOperationError extends Error {
  readonly code: McpToolOperationErrorCode;

  constructor(code: McpToolOperationErrorCode, message: string) {
    super(message);
    this.name = "McpToolOperationError";
    this.code = code;
  }
}

/** Only `conflict` is retryable: the caller re-reads state and tries again. */
const RETRYABLE_CODES: ReadonlySet<McpToolOperationErrorCode> = new Set(["conflict"]);

export interface McpServerTool<TAuth = SessionAuthContext | null> {
  readonly name: string;
  register(server: McpServer, auth: TAuth): void;
  /**
   * The same tool for a feature that owns `tools/list` and `tools/call`
   * itself: the list entry the SDK would build, and a call that validates
   * input the way the SDK does.
   */
  readonly raw: McpRawTool<TAuth>;
}

export interface McpRawTool<TAuth> {
  listed(): McpJsonObject;
  call(
    args: unknown,
    context: { readonly auth: TAuth; readonly signal: AbortSignal },
  ): Promise<McpCallToolResult>;
}

/** The request a {@link McpServerFeature} registers its handlers for. */
export interface McpServerFeatureContext<TAuth> {
  /** Whatever `authenticate` resolved for this request. */
  readonly auth: TAuth;
  /** `modern` for MCP 2026-07-28 requests, `legacy` for the stateless 2025 fallback. */
  readonly era: "legacy" | "modern";
}

/**
 * A slice of the MCP surface (tools, skills, ...) plugged into the server.
 * Every request builds a fresh server, so `register` runs once per request,
 * after `capabilities` are merged and before the SDK dispatches.
 */
export interface McpServerFeature<TAuth = SessionAuthContext | null> {
  /**
   * Capabilities this feature serves. Merged one level deep into the
   * server's own (so `extensions` entries from several features combine).
   * Declaring a capability obliges `register` to set its handlers.
   */
  readonly capabilities?: McpJsonObject;
  register(server: McpServer, context: McpServerFeatureContext<TAuth>): void;
  /**
   * The subset of `uris` this feature can notify about, for a
   * `subscriptions/listen` `resourceSubscriptions` filter. A URI no feature
   * claims is dropped before the SDK acknowledges the filter.
   */
  filterResourceSubscriptions?(uris: readonly string[]): Promise<readonly string[]>;
}

interface McpStreamableHttpServerOptions<TAuth> {
  readonly name: string;
  readonly version: string;
  /** Server-level usage guidance returned from `initialize` and `server/discover`. */
  readonly instructions?: string;
  /**
   * Tools registered through the SDK's Standard Schema path. When set, the
   * server declares `tools` even if the list is empty.
   */
  readonly tools?: readonly McpServerTool<TAuth>[];
  /** Handler sets plugged in after the base server is built. */
  readonly features?: readonly McpServerFeature<TAuth>[];
  /** Verifies an echoed `requestState`; any throw answers the SDK's `-32602`. */
  readonly requestState?: {
    readonly verify: (state: string, ctx: McpRequestHandlerExtra) => unknown;
  };
  /** `ttlMs` / `cacheScope` for the cacheable 2026-07-28 results the SDK builds. */
  readonly cacheHints?: Partial<Record<CacheableResultMethod, CacheHint>>;
  /**
   * `ack-then-close` ends a `subscriptions/listen` stream right after its
   * `notifications/subscriptions/acknowledged` event, without a completion
   * result. Defaults to the SDK's open stream.
   */
  readonly listen?: "ack-then-close" | "stream";
  authenticate(request: Request): Promise<TAuth | Response>;
}

/**
 * Upper bound on open `subscriptions/listen` streams per handler. Every
 * request builds its own handler, so this caps one request; with
 * `listen: "ack-then-close"` no stream outlives its ack anyway.
 */
const MCP_MAX_SUBSCRIPTIONS_PER_HANDLER = 1;

/** Most resource URIs one `subscriptions/listen` filter may name. */
export const MCP_MAX_RESOURCE_SUBSCRIPTIONS = 100;

/**
 * Creates a dual-era, stateless MCP HTTP request handler.
 *
 * Current clients use MCP 2026-07-28's per-request envelope. Older clients
 * fall back to the SDK's stateless 2025 Streamable HTTP implementation.
 */
export function createMcpStreamableHttpServer<TAuth = SessionAuthContext | null>(
  options: McpStreamableHttpServerOptions<TAuth>,
): (request: Request) => Promise<Response> {
  const tools =
    options.tools === undefined
      ? undefined
      : new Map(options.tools.map((tool) => [tool.name, tool]));
  if (tools !== undefined && tools.size !== options.tools?.length) {
    throw new Error("MCP tool names must be unique.");
  }

  return async (request) => {
    const auth = await options.authenticate(request);
    if (auth instanceof Response) return auth;

    const handler = createMcpHandler(({ era }) => createServer(options, tools, auth, era), {
      legacy: "stateless",
      maxSubscriptions: MCP_MAX_SUBSCRIPTIONS_PER_HANDLER,
      onerror(error) {
        // requestState rejections and transport faults: the client already
        // got its error response; the reason is only useful when debugging.
        log.debug("MCP handler error", { error: error.message });
      },
    });
    if (request.method.toUpperCase() !== "POST") return await handler.fetch(request);

    // Every POST body is read here, bounded, before the SDK sees it. The
    // parsed value is handed to the SDK so the body is never read twice.
    const inspected = await inspectRequestBody(request);
    if (inspected.tooLarge) return requestBodyTooLargeResponse();
    if (inspected.invalidJson) return invalidJsonResponse();
    let parsedBody = inspected.value;
    if (parsedBody === undefined) return await handler.fetch(request);
    if (isListenRequest(parsedBody)) {
      const narrowed = await narrowListenRequest(parsedBody, options.features ?? []);
      if (narrowed instanceof Response) return narrowed;
      parsedBody = narrowed;
    }

    const preflightFailure = await preflightModernRequest(request, parsedBody);
    if (preflightFailure !== undefined) return preflightFailure;

    const response = await handler.fetch(request, { parsedBody });
    if (options.listen === "ack-then-close" && isListenRequest(parsedBody)) {
      return closeAfterListenAck(response);
    }
    return response;
  };
}

function isListenRequest(body: unknown): body is Readonly<Record<string, unknown>> {
  return isPlainRecord(body) && body.method === "subscriptions/listen";
}

const LISTEN_ACK_METHOD = "notifications/subscriptions/acknowledged";

/**
 * Bounds and narrows a listen request's `resourceSubscriptions` before the
 * SDK, which acknowledges whatever URIs it is given. Over
 * {@link MCP_MAX_RESOURCE_SUBSCRIPTIONS} answers `-32602`. Otherwise only
 * the URIs some feature can notify about are kept, so the ack lists exactly
 * the subscriptions that are honored. Malformed filters pass through for the
 * SDK to refuse.
 */
async function narrowListenRequest<TAuth>(
  body: Readonly<Record<string, unknown>>,
  features: readonly McpServerFeature<TAuth>[],
): Promise<unknown> {
  const params = body.params;
  if (!isPlainRecord(params) || !isPlainRecord(params.notifications)) return body;
  const requested = params.notifications.resourceSubscriptions;
  if (!Array.isArray(requested)) return body;
  if (!requested.every((uri): uri is string => typeof uri === "string")) return body;
  if (requested.length > MCP_MAX_RESOURCE_SUBSCRIPTIONS) {
    return Response.json(
      {
        error: {
          code: -32_602,
          message: `resourceSubscriptions may name at most ${MCP_MAX_RESOURCE_SUBSCRIPTIONS} URIs (got ${requested.length}).`,
        },
        id: isJsonRpcId(body.id) ? body.id : null,
        jsonrpc: "2.0",
      },
      { status: 200 },
    );
  }
  const unique = [...new Set(requested)];
  const supported = new Set<string>();
  for (const feature of features) {
    if (feature.filterResourceSubscriptions === undefined) continue;
    for (const uri of await feature.filterResourceSubscriptions(unique)) supported.add(uri);
  }
  const resourceSubscriptions = unique.filter((uri) => supported.has(uri));
  const { resourceSubscriptions: _dropped, ...notifications } = params.notifications;
  return {
    ...body,
    params: {
      ...params,
      notifications:
        resourceSubscriptions.length === 0
          ? notifications
          : { ...notifications, resourceSubscriptions },
    },
  };
}

function isJsonRpcId(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

/**
 * Passes a `subscriptions/listen` SSE stream through until the event carrying
 * the acknowledgement, then ends it. Cancelling the SDK's stream tears the
 * subscription down without the graceful completion result, so the client
 * sees the ack and then a closed stream. Non-SSE responses (errors) pass
 * through untouched.
 */
export function closeAfterListenAck(response: Response): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (response.body === null || !contentType.includes("text/event-stream")) return response;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending: Uint8Array = new Uint8Array(0);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // A pull that enqueues nothing is not called again, so read until a
      // whole event is ready or the source ends.
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (pending.byteLength > 0) controller.enqueue(new Uint8Array(pending));
          controller.close();
          return;
        }
        pending = concatBytes(pending, chunk.value);
        let forwarded = false;
        let boundary = findEventBoundary(pending);
        while (boundary !== -1) {
          const event = new Uint8Array(pending.subarray(0, boundary));
          pending = pending.slice(boundary);
          controller.enqueue(event);
          forwarded = true;
          if (decoder.decode(event).includes(LISTEN_ACK_METHOD)) {
            controller.close();
            await reader.cancel().catch(() => {});
            return;
          }
          boundary = findEventBoundary(pending);
        }
        if (forwarded) return;
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/** Index just past the first SSE event terminator (a blank line), or -1. */
function findEventBoundary(bytes: Uint8Array): number {
  for (let index = 0; index < bytes.byteLength - 1; index += 1) {
    if (bytes[index] === 0x0a && bytes[index + 1] === 0x0a) return index + 2;
    if (
      bytes[index] === 0x0d &&
      bytes[index + 1] === 0x0a &&
      bytes[index + 2] === 0x0d &&
      bytes[index + 3] === 0x0a
    ) {
      return index + 4;
    }
  }
  return -1;
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  if (left.byteLength === 0) return right;
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

/**
 * The SDK currently checks MCP-Protocol-Version only when the header is
 * present. MCP 2026-07-28 requires it on every modern POST, so reject the
 * missing-header case here until the upstream handler does:
 * modelcontextprotocol/typescript-sdk#2589.
 */
async function preflightModernRequest(
  request: Request,
  parsedBody: unknown,
): Promise<Response | undefined> {
  if (request.headers.has("mcp-protocol-version")) return undefined;
  if (!claimsCurrentProtocolVersion(parsedBody)) return undefined;

  const earlierFailure = await probeEarlierValidationFailure(request, parsedBody);
  return earlierFailure ?? headerMismatchResponse(parsedBody);
}

async function inspectRequestBody(request: Request): Promise<{
  readonly invalidJson?: boolean;
  readonly tooLarge: boolean;
  readonly value?: unknown;
}> {
  const body = request.body;
  if (body === null) return { tooLarge: false };

  // Trust a declared length only to fail fast; the streamed count is the guard.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MCP_REQUEST_BODY_MAX_BYTES) {
    await body.cancel().catch(() => {});
    return { tooLarge: true };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MCP_REQUEST_BODY_MAX_BYTES) {
        await reader.cancel();
        return { tooLarge: true };
      }
      chunks.push(chunk.value);
    }

    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { tooLarge: false, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { invalidJson: true, tooLarge: false };
  }
}

function invalidJsonResponse(): Response {
  return Response.json(
    {
      error: { code: -32_700, message: "Parse error" },
      id: null,
      jsonrpc: "2.0",
    },
    { status: 400 },
  );
}

function requestBodyTooLargeResponse(): Response {
  return Response.json(
    {
      error: { code: -32_000, message: "Request body too large" },
      id: null,
      jsonrpc: "2.0",
    },
    { status: 413, statusText: "Request Entity Too Large" },
  );
}

function claimsCurrentProtocolVersion(body: unknown): boolean {
  return (
    isPlainRecord(body) &&
    isPlainRecord(body.params) &&
    isPlainRecord(body.params._meta) &&
    body.params._meta["io.modelcontextprotocol/protocolVersion"] === MCP_PROTOCOL_VERSION
  );
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ask a side-effect-free SDK handler to apply the validation rungs that
 * precede required standard-header presence. Preserve those errors; otherwise
 * the valid current-revision envelope is ready for the missing-header error.
 */
async function probeEarlierValidationFailure(
  request: Request,
  parsedBody: unknown,
): Promise<Response | undefined> {
  const headers = new Headers(request.headers);
  headers.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
  const probeRequest = new Request(request.url, {
    body: JSON.stringify(parsedBody),
    headers,
    method: request.method,
  });
  const probe = createMcpHandler(() => new McpServer({ name: "eve-mcp-preflight", version: "0" }), {
    legacy: "reject",
  });
  try {
    const response = await probe.fetch(probeRequest, { parsedBody });
    if (response.status === 406 || response.status === 415) {
      return response;
    }
    if (response.status === 400) {
      const body = (await response
        .clone()
        .json()
        .catch(() => undefined)) as { readonly error?: { readonly code?: unknown } } | undefined;
      if (
        body?.error?.code === -32_700 ||
        body?.error?.code === -32_600 ||
        body?.error?.code === -32_602 ||
        body?.error?.code === -32_022
      ) {
        return response;
      }
    }
    await response.body?.cancel();
    return undefined;
  } finally {
    await probe.close().catch(() => {});
  }
}

function headerMismatchResponse(body: unknown): Response {
  const mismatchBody =
    "the body carries a modern MCP envelope but the required MCP-Protocol-Version header is absent";
  return Response.json(
    {
      error: {
        code: -32_020,
        data: {
          mismatch: {
            body: mismatchBody,
            header: "(missing)",
          },
        },
        message: `Bad Request: the request headers and body disagree: ${mismatchBody}`,
      },
      id: readJsonRpcRequestId(body),
      jsonrpc: "2.0",
    },
    { status: 400 },
  );
}

function readJsonRpcRequestId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const id = Reflect.get(body, "id");
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function createServer<TAuth>(
  options: Pick<
    McpStreamableHttpServerOptions<TAuth>,
    "cacheHints" | "features" | "instructions" | "name" | "requestState" | "version"
  >,
  tools: ReadonlyMap<string, McpServerTool<TAuth>> | undefined,
  auth: TAuth,
  era: "legacy" | "modern",
): McpServer {
  const serverOptions: { -readonly [K in keyof McpServerOptions]: McpServerOptions[K] } = {};
  // `tools` in the constructor makes McpServer install its own list/call
  // handlers, which only the Standard Schema path wants.
  if (tools !== undefined) serverOptions.capabilities = { tools: { listChanged: false } };
  if (options.instructions !== undefined) serverOptions.instructions = options.instructions;
  if (options.requestState !== undefined) serverOptions.requestState = options.requestState;
  if (options.cacheHints !== undefined) serverOptions.cacheHints = options.cacheHints;
  const server = new McpServer({ name: options.name, version: options.version }, serverOptions);

  for (const tool of tools?.values() ?? []) tool.register(server, auth);
  for (const feature of options.features ?? []) {
    if (feature.capabilities !== undefined)
      server.server.registerCapabilities(feature.capabilities);
  }
  for (const feature of options.features ?? []) feature.register(server, { auth, era });

  return server;
}

export async function callTool<
  TInput,
  TStructured extends Readonly<Record<string, unknown>>,
  TAuth,
>(
  call: (
    input: TInput,
    context: { readonly auth: TAuth; readonly signal: AbortSignal },
  ) => Promise<McpCallToolResult<TStructured>>,
  input: TInput,
  signal: AbortSignal,
  auth: TAuth,
): Promise<McpCallToolResult<TStructured>> {
  try {
    return await call(input, { auth, signal });
  } catch (error) {
    if (error instanceof McpToolOperationError) {
      return toolError({
        code: error.code,
        message: error.message,
        retryable: RETRYABLE_CODES.has(error.code),
      });
    }
    // Unexpected failures never forward their message: it may carry provider
    // responses, hostnames, or workflow payloads. The errorId is the handle.
    const errorId = logError(log, "MCP tool call failed", error);
    return toolError({
      code: "internal",
      errorId,
      message: "The server could not complete this tool call.",
      retryable: false,
    });
  }
}

function toolError<TStructured extends Readonly<Record<string, unknown>>>(
  error: McpToolOperationErrorData,
): McpCallToolResult<TStructured> {
  const text =
    error.errorId === undefined ? error.message : `${error.message} (errorId: ${error.errorId})`;
  // The SDK skips outputSchema validation when isError is set, so this shape
  // does not need to appear in each tool's declared output schema.
  return {
    content: [{ type: "text", text }],
    isError: true,
    structuredContent: { error },
  };
}
