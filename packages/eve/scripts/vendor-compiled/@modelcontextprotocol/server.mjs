export default {
  packageName: "@modelcontextprotocol/server",
  compiledPath: "@modelcontextprotocol/server",
  chunkGroup: "workflow",
  entries: [
    {
      entry: "dist/index.mjs",
      outputPath: "index",
      declaration: `
export interface CallToolRequest {
  readonly params: {
    readonly _meta?: Readonly<Record<string, unknown>>;
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly name: string;
  };
}

export type McpJsonObject = Readonly<Record<string, unknown>>;

export interface McpRequestHandlerExtra {
  readonly mcpReq: {
    readonly id: string | number;
    readonly method: string;
    /** Request \`_meta\` with the reserved \`io.modelcontextprotocol/*\` keys lifted out. */
    readonly _meta?: McpJsonObject;
    /** The 2026-07-28 per-request envelope (\`io.modelcontextprotocol/*\` keys). */
    readonly envelope?: McpJsonObject;
    /** Bare multi-round-trip responses keyed by the server's input request keys. */
    readonly inputResponses?: McpJsonObject;
    /** The value \`ServerOptions.requestState.verify\` resolved with, or the raw string. */
    requestState<T = unknown>(): T | undefined;
    readonly signal: AbortSignal;
  };
}

export interface McpToolAnnotations {
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  readonly readOnlyHint?: boolean;
}

export interface StandardSchemaWithJSON<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly types?: { readonly input: TInput; readonly output: TOutput };
  };
}

export interface StandardSchemaV1<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: TInput; readonly output: TOutput };
  };
}

export type CacheScope = "private" | "public";

export interface CacheHint {
  readonly cacheScope?: CacheScope;
  readonly ttlMs?: number;
}

export type CacheableResultMethod =
  | "prompts/list"
  | "resources/list"
  | "resources/read"
  | "resources/templates/list"
  | "server/discover"
  | "tools/list";

export interface McpServerOptions {
  readonly cacheHints?: Partial<Record<CacheableResultMethod, CacheHint>>;
  readonly capabilities?: McpJsonObject;
  readonly instructions?: string;
  readonly requestState?: {
    readonly verify?: (state: string, ctx: McpRequestHandlerExtra) => unknown;
  };
}

export declare class Server {
  constructor(info: { readonly name: string; readonly version: string }, options?: McpServerOptions);
  getCapabilities(): McpJsonObject;
  /** On 2025-era instances, the capabilities the client declared in \`initialize\`. */
  getClientCapabilities(): McpJsonObject | undefined;
  registerCapabilities(capabilities: McpJsonObject): void;
  setRequestHandler<Result>(
    method: "tools/list",
    handler: (
      request: { readonly params?: McpJsonObject },
      context: McpRequestHandlerExtra,
    ) => Result | Promise<Result>,
  ): void;
  setRequestHandler<Result>(
    method: "tools/call",
    handler: (
      request: CallToolRequest,
      context: McpRequestHandlerExtra,
    ) => Result | Promise<Result>,
  ): void;
  /** Spec methods validated by the SDK's own wire schemas. */
  setRequestHandler<Result>(
    method: "resources/list" | "resources/read" | "resources/templates/list",
    handler: (
      request: { readonly params?: McpJsonObject },
      context: McpRequestHandlerExtra,
    ) => Result | Promise<Result>,
  ): void;
  /** Custom (non-spec) methods: params are validated by the given schema. */
  setRequestHandler<TParams, Result>(
    method: string,
    schemas: { readonly params: StandardSchemaV1<unknown, TParams>; readonly result?: StandardSchemaV1 },
    handler: (params: TParams, context: McpRequestHandlerExtra) => Result | Promise<Result>,
  ): void;
}

export declare class McpServer {
  readonly server: Server;
  constructor(info: { readonly name: string; readonly version: string }, options?: McpServerOptions);
  registerTool<TInput = unknown, TOutput = TInput>(
    name: string,
    config: {
      readonly annotations?: McpToolAnnotations;
      readonly description?: string;
      readonly inputSchema: StandardSchemaWithJSON<TInput, TOutput>;
      readonly outputSchema?: StandardSchemaWithJSON;
    },
    callback: (
      input: TOutput,
      context: McpRequestHandlerExtra,
    ) => unknown | Promise<unknown>,
  ): void;
}

export declare class ProtocolError extends Error {
  constructor(code: number, message: string, data?: unknown);
  readonly code: number;
  readonly data?: unknown;
}

export interface RequestStateCodec<T = unknown> {
  mint(payload: T): Promise<string>;
  verify(state: string, ctx: McpRequestHandlerExtra): Promise<T>;
}

export declare function createRequestStateCodec<T = unknown>(options: {
  readonly key: Uint8Array | string;
  readonly ttlSeconds?: number;
}): RequestStateCodec<T>;

export type InputResponseView =
  | { readonly kind: "missing" }
  | {
      readonly kind: "elicit";
      readonly action: "accept" | "cancel" | "decline";
      readonly content?: McpJsonObject;
    }
  | { readonly kind: "roots" }
  | { readonly kind: "sampling" };

export declare function inputResponse(
  responses: McpJsonObject | undefined,
  key: string,
): InputResponseView;

export interface McpRequestContext {
  readonly era: "legacy" | "modern";
  readonly requestInfo: Request;
}

export interface McpHandler {
  close(): Promise<void>;
  fetch(request: Request, options?: { readonly parsedBody?: unknown }): Promise<Response>;
}

export declare function fromJsonSchema<T = unknown>(
  schema: Readonly<Record<string, unknown>>,
): StandardSchemaWithJSON<T, T>;

export declare function hostHeaderValidationResponse(
  request: Request,
  allowedHostnames: readonly string[],
): Response | undefined;

export declare function originValidationResponse(
  request: Request,
  allowedOriginHostnames: readonly string[],
): Response | undefined;

export declare function createMcpHandler(
  factory: (context: McpRequestContext) => McpServer | Server | Promise<McpServer | Server>,
  options?: {
    readonly keepAliveMs?: number;
    readonly legacy?: "reject" | "stateless";
    readonly maxSubscriptions?: number;
    readonly onerror?: (error: Error) => void;
    readonly responseMode?: "auto" | "json" | "stream";
  },
): McpHandler;
`,
    },
  ],
  platform: "neutral",
};
