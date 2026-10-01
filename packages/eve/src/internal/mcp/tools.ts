import {
  inputResponse,
  ProtocolError,
  type McpJsonObject,
  type McpRequestHandlerExtra,
  type McpServer,
} from "#compiled/@modelcontextprotocol/server/index.js";

import type { AgentToolDescription } from "#channel/agent-description.js";
import type {
  InvokeToolAuthorizationChallenge,
  InvokeToolFn,
  InvokeToolOptions,
  InvokeToolResult,
} from "#channel/invoke-tool.js";
import { deriveToolSessionId, validateToolSessionKey } from "#execution/tool-session/id.js";
import type { McpRequestPrincipals } from "#internal/mcp/forwarded-principal-header.js";
import {
  hashToolArguments,
  type McpRequestStateCodec,
  type McpRequestStatePayload,
  type McpRequestStateSignIn,
} from "#internal/mcp/request-state.js";
import type { ToolModelOutput } from "#tools/model-output.js";

/** `_meta` key carrying the caller's tool session key on `tools/call`. */
export const MCP_TOOL_SESSION_META_KEY = "dev.eve/tool-session";
/** Extension identifier eve advertises for tool sessions. */
export const MCP_TOOL_SESSIONS_EXTENSION = "dev.eve/tool-sessions";
/** `_meta` key marking a tool with an approval policy, and the approval input request key. */
export const MCP_APPROVAL_KEY = "dev.eve/approval";
/** Prefix of the sign-in input request keys; the connection name follows. */
export const MCP_AUTHORIZATION_KEY_PREFIX = "dev.eve/authorization:";
/** `_meta` key on a sign-in `input_required` result. */
export const MCP_AUTHORIZATION_META_KEY = "dev.eve/authorization";
/** `_meta` key reporting how a call reached its sandbox. */
export const MCP_SANDBOX_META_KEY = "dev.eve/sandbox";

const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

const INVALID_REQUEST_STATE_MESSAGE = "Invalid or expired requestState";
const INVALID_PARAMS = -32_602;

/** Where `requestState` comes from: a codec, or why there is none. */
export type McpToolsRequestState =
  | { readonly codec: McpRequestStateCodec; readonly kind: "codec" }
  | { readonly kind: "missing"; readonly reason: string };

/** What the tools adapter needs for one request. */
export interface McpToolsContext {
  readonly era: "legacy" | "modern";
  readonly invokeTool: InvokeToolFn;
  readonly principals: McpRequestPrincipals;
  readonly requestState: McpToolsRequestState;
  /** The agent's described tools, sorted by name. Non-invocable ones are dropped here. */
  readonly tools: readonly AgentToolDescription[];
}

/** Capabilities the tools adapter adds to `server/discover` and `initialize`. */
export const MCP_TOOLS_CAPABILITIES = {
  extensions: { [MCP_TOOL_SESSIONS_EXTENSION]: {} },
  tools: { listChanged: true },
} as const;

type McpContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image" | "audio"; readonly data: string; readonly mimeType: string }
  | {
      readonly type: "resource";
      readonly resource: { readonly blob: string; readonly mimeType: string; readonly uri: string };
    };

/** A `tools/call` result as eve sends it. */
export type McpToolCallResult =
  | {
      readonly _meta?: McpJsonObject;
      readonly content: readonly McpContentBlock[];
      readonly isError?: true;
      readonly structuredContent?: McpJsonObject;
    }
  | {
      readonly _meta: McpJsonObject;
      readonly inputRequests: McpJsonObject;
      readonly requestState: string;
      readonly resultType: "input_required";
    };

type McpToolErrorCode = "denied" | "input_unsupported" | "internal" | "invalid_input";

/**
 * Serves `tools/list` and `tools/call` from the agent's description and
 * `invokeTool`. Schemas pass through as compiled; nothing is converted.
 */
export function registerMcpTools(server: McpServer, context: McpToolsContext): void {
  const invocable = context.tools.filter((tool) => tool.invocable);
  const byName = new Map(invocable.map((tool) => [tool.name, tool]));
  server.server.setRequestHandler("tools/list", () => ({
    tools: invocable.map(toListedTool),
  }));
  server.server.setRequestHandler(
    "tools/call",
    async (request, ctx) => await callMcpTool(server, context, byName, request.params, ctx),
  );
}

function toListedTool(tool: AgentToolDescription): McpJsonObject {
  const listed: Record<string, unknown> = {
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.name,
  };
  if (tool.outputSchema !== undefined) listed.outputSchema = tool.outputSchema;
  if (tool.approval) listed._meta = { [MCP_APPROVAL_KEY]: true };
  return listed;
}

/** Derives the tool session id the way core does, from this request's principals. */
function sessionIdFor(principals: McpRequestPrincipals, key: ToolSessionKey): string {
  if (principals.forwarder === undefined) {
    return deriveToolSessionId({ current: principals.current, key });
  }
  return deriveToolSessionId({ current: principals.current, forwarder: principals.forwarder, key });
}

type ToolSessionKey = Parameters<typeof deriveToolSessionId>[0]["key"];

async function callMcpTool(
  server: McpServer,
  context: McpToolsContext,
  tools: ReadonlyMap<string, AgentToolDescription>,
  params: { readonly arguments?: McpJsonObject; readonly name: string },
  ctx: McpRequestHandlerExtra,
): Promise<McpToolCallResult> {
  const name = params.name;
  // Unknown and non-invocable names are the same miss: neither is listed.
  if (!tools.has(name)) throw new ProtocolError(INVALID_PARAMS, `Tool ${name} not found`);
  const args = params.arguments ?? {};

  // The key only counts for a client that declared the extension. Anyone
  // else gets a one-off session, and a stray key is ignored, not validated,
  // so invocation, minting, and retry binding all see the same `undefined`.
  let key: string | undefined;
  if (declaresToolSessions(server, context, ctx)) {
    const rawKey = ctx.mcpReq._meta?.[MCP_TOOL_SESSION_META_KEY];
    if (rawKey !== undefined && typeof rawKey !== "string") {
      return toolError("invalid_input", `_meta["${MCP_TOOL_SESSION_META_KEY}"] must be a string.`);
    }
    if (rawKey !== undefined) {
      const problem = validateToolSessionKey(rawKey);
      if (problem !== undefined) return toolError("invalid_input", problem);
    }
    key = rawKey;
  }

  const options: {
    -readonly [K in keyof InvokeToolOptions]: InvokeToolOptions[K];
  } = {
    auth: context.principals.current,
    signal: ctx.mcpReq.signal,
  };
  if (context.principals.forwarder !== undefined) options.forwarder = context.principals.forwarder;
  if (context.principals.initiator !== undefined) options.initiator = context.principals.initiator;
  if (key !== undefined) options.key = key;

  // The SDK already verified the MAC and expiry (or refused with -32602).
  // What is left is binding: same session, same tool, same arguments.
  const state = readVerifiedState(ctx);
  if (state !== undefined) {
    assertStateBinding(state, { args, key, name, principals: context.principals });
    options.callId = state.callId;
    if (key === undefined && state.nonce !== undefined) options.oneOffNonce = state.nonce;
    const responses = ctx.mcpReq.inputResponses;
    if (state.kind === "approval") {
      const answer = readApprovalAnswer(responses);
      // No answer: ask again from the signed state. Core does not run.
      if (answer === undefined) return await askAgain(server, context, ctx, state);
      options.approval = answer;
    } else {
      // The codec refuses an authorization state without sign-ins; never
      // read an empty list as "every sign-in accepted".
      if (state.authorization === undefined || state.authorization.length === 0) {
        throw invalidRequestState();
      }
      const answers = readAuthorizationAnswers(responses, state.authorization);
      if (answers.kind === "refused") return toolError("denied", refusalMessage(answers.refused));
      if (answers.kind === "missing") {
        return await askAgain(server, context, ctx, { ...state, authorization: answers.missing });
      }
      // Every sign-in was accepted. Core checks the grants itself and asks
      // again if one is still missing. The approval answer that led to this
      // round is restored only here, from the round that carried it.
      if (state.approval !== undefined) options.approval = state.approval;
    }
  }

  const result = await context.invokeTool(name, args, options);
  return await toMcpToolResult(server, context, ctx, {
    args,
    carriedApproval: options.approval,
    key,
    name,
    result,
  });
}

function readVerifiedState(ctx: McpRequestHandlerExtra): McpRequestStatePayload | undefined {
  const state = ctx.mcpReq.requestState<unknown>();
  if (state === undefined) return undefined;
  // `verify` resolves with a checked payload. A raw string means no verify
  // hook ran, which eve never configures; refuse rather than trust it.
  if (typeof state === "string") throw invalidRequestState();
  return state as McpRequestStatePayload;
}

function assertStateBinding(
  state: McpRequestStatePayload,
  request: {
    readonly args: unknown;
    readonly key: string | undefined;
    readonly name: string;
    readonly principals: McpRequestPrincipals;
  },
): void {
  if (state.tool !== request.name) throw invalidRequestState();
  if (state.args !== hashToolArguments(request.args)) throw invalidRequestState();
  let sid: string;
  if (request.key !== undefined) {
    sid = sessionIdFor(request.principals, { kind: "key", value: request.key });
  } else if (state.nonce !== undefined) {
    sid = sessionIdFor(request.principals, { kind: "one-off", nonce: state.nonce });
  } else {
    throw invalidRequestState();
  }
  if (sid !== state.sid) throw invalidRequestState();
}

/**
 * Whether the request declared `dev.eve/tool-sessions` in its client
 * capabilities, the same place elicitation modes are read from.
 */
function declaresToolSessions(
  server: McpServer,
  context: McpToolsContext,
  ctx: McpRequestHandlerExtra,
): boolean {
  const declared = declaredCapabilities(server, context, ctx);
  if (declared === undefined) return false;
  const extensions = declared.extensions;
  return isJsonObject(extensions) && isJsonObject(extensions[MCP_TOOL_SESSIONS_EXTENSION]);
}

type AuthorizationAnswers =
  | { readonly kind: "accepted" }
  | { readonly kind: "missing"; readonly missing: readonly McpRequestStateSignIn[] }
  | {
      readonly kind: "refused";
      readonly refused: readonly {
        readonly action: "cancel" | "decline";
        readonly name: string;
      }[];
    };

/**
 * Reads the answers to every sign-in the round asked for. Any decline or
 * cancel refuses the call. Otherwise any sign-in without an elicitation
 * answer is still outstanding. Only when every one was accepted may core run.
 */
export function readAuthorizationAnswers(
  responses: McpJsonObject | undefined,
  outstanding: readonly McpRequestStateSignIn[],
): AuthorizationAnswers {
  const refused: { action: "cancel" | "decline"; name: string }[] = [];
  const missing: McpRequestStateSignIn[] = [];
  for (const signIn of outstanding) {
    const view = inputResponse(responses, `${MCP_AUTHORIZATION_KEY_PREFIX}${signIn.name}`);
    if (view.kind !== "elicit") missing.push(signIn);
    else if (view.action !== "accept") refused.push({ action: view.action, name: signIn.name });
  }
  if (refused.length > 0) return { kind: "refused", refused };
  if (missing.length > 0) return { kind: "missing", missing };
  return { kind: "accepted" };
}

function refusalMessage(
  refused: readonly { readonly action: "cancel" | "decline"; readonly name: string }[],
): string {
  return refused
    .map(
      (entry) =>
        `The sign-in to "${entry.name}" was ${entry.action === "cancel" ? "cancelled" : "declined"}.`,
    )
    .join(" ");
}

/**
 * Re-asks the questions a signed state still has open, without calling core:
 * the approval form, or the sign-ins that got no answer. The new state keeps
 * every binding and lists only what is still outstanding.
 */
async function askAgain(
  server: McpServer,
  context: McpToolsContext,
  ctx: McpRequestHandlerExtra,
  state: McpRequestStatePayload,
): Promise<McpToolCallResult> {
  if (context.requestState.kind === "missing") {
    return toolError("internal", context.requestState.reason);
  }
  const payload: { -readonly [K in keyof McpRequestStatePayload]: McpRequestStatePayload[K] } = {
    args: state.args,
    callId: state.callId,
    kind: state.kind,
    sid: state.sid,
    tool: state.tool,
    v: 1,
  };
  if (state.nonce !== undefined) payload.nonce = state.nonce;
  if (state.kind === "approval") {
    if (!clientSupports(server, context, ctx, "form")) return approvalUnsupported(state.tool);
    const requestState = await context.requestState.codec.mint(payload);
    return approvalRequest(state.callId, state.tool, requestState);
  }
  const signIns = state.authorization ?? [];
  if (!clientSupports(server, context, ctx, "url")) {
    return signInUnsupported(
      state.tool,
      signIns.map((entry) => entry.name),
    );
  }
  if (state.approval !== undefined) payload.approval = state.approval;
  payload.authorization = signIns;
  const requestState = await context.requestState.codec.mint(payload);
  return authorizationRequest(state.callId, signIns, requestState);
}

function invalidRequestState(): ProtocolError {
  return new ProtocolError(INVALID_PARAMS, INVALID_REQUEST_STATE_MESSAGE, {
    reason: "invalid_request_state",
  });
}

/**
 * Reads the person's approval answer. Accept with `approved: true` approves;
 * accept with `approved: false`, decline, and cancel deny. Anything else, an
 * absent answer included, is no answer: the caller is asked again.
 */
export function readApprovalAnswer(
  responses: McpJsonObject | undefined,
): { readonly approved: boolean } | undefined {
  const view = inputResponse(responses, MCP_APPROVAL_KEY);
  if (view.kind !== "elicit") return undefined;
  if (view.action === "decline" || view.action === "cancel") return { approved: false };
  const approved = view.content?.approved;
  return typeof approved === "boolean" ? { approved } : undefined;
}

async function toMcpToolResult(
  server: McpServer,
  context: McpToolsContext,
  ctx: McpRequestHandlerExtra,
  call: {
    readonly args: unknown;
    readonly carriedApproval: { readonly approved: boolean } | undefined;
    readonly key: string | undefined;
    readonly name: string;
    readonly result: InvokeToolResult;
  },
): Promise<McpToolCallResult> {
  const { result } = call;
  const sandboxMeta =
    result.sandbox === undefined
      ? undefined
      : { [MCP_SANDBOX_META_KEY]: { ms: result.sandbox.ms, state: result.sandbox.state } };
  const withSandbox = <T extends McpToolCallResult>(value: T): T =>
    sandboxMeta === undefined
      ? value
      : ({ ...value, _meta: { ...value._meta, ...sandboxMeta } } as T);

  switch (result.status) {
    case "completed": {
      const completed: { content: readonly McpContentBlock[]; structuredContent?: McpJsonObject } =
        { content: toContent(result.modelOutput) };
      if (isJsonObject(result.output)) completed.structuredContent = result.output;
      return withSandbox(completed);
    }
    case "failed":
      return withSandbox(toolError("internal", result.message, result.errorId));
    case "invalid-input":
      return withSandbox(toolError("invalid_input", result.message));
    case "denied":
      return withSandbox(toolError("denied", result.reason ?? "The call was denied."));
    case "approval-required": {
      if (!clientSupports(server, context, ctx, "form")) {
        return withSandbox(approvalUnsupported(call.name));
      }
      if (context.requestState.kind === "missing") {
        return withSandbox(toolError("internal", context.requestState.reason));
      }
      const requestState = await context.requestState.codec.mint(
        statePayload(context, call, "approval", result.callId, result.oneOffNonce),
      );
      return withSandbox(approvalRequest(result.callId, call.name, requestState));
    }
    case "authorization-required": {
      const missingUrl = result.challenges.find((entry) => entry.challenge.url === undefined);
      if (missingUrl !== undefined) {
        return withSandbox(
          toolError(
            "input_unsupported",
            `The connection "${missingUrl.name}" needs a sign-in without a URL, which MCP cannot ask a client for.`,
          ),
        );
      }
      if (!clientSupports(server, context, ctx, "url")) {
        return withSandbox(
          signInUnsupported(
            call.name,
            result.challenges.map((entry) => entry.name),
          ),
        );
      }
      if (context.requestState.kind === "missing") {
        return withSandbox(toolError("internal", context.requestState.reason));
      }
      const signIns = result.challenges.map(toSignIn);
      const requestState = await context.requestState.codec.mint({
        ...statePayload(context, call, "authorization", result.callId, result.oneOffNonce),
        authorization: signIns,
      });
      return withSandbox(authorizationRequest(result.callId, signIns, requestState));
    }
  }
}

function toSignIn(entry: InvokeToolAuthorizationChallenge): McpRequestStateSignIn {
  const { url, userCode } = entry.challenge;
  // Challenges without a URL were refused before this point.
  if (url === undefined) throw new Error(`The sign-in to "${entry.name}" has no URL.`);
  return userCode === undefined ? { name: entry.name, url } : { name: entry.name, url, userCode };
}

function approvalUnsupported(tool: string): Extract<McpToolCallResult, { content: unknown }> {
  return toolError(
    "input_unsupported",
    `The tool "${tool}" needs approval, and this client did not declare form elicitation.`,
  );
}

function signInUnsupported(
  tool: string,
  names: readonly string[],
): Extract<McpToolCallResult, { content: unknown }> {
  return toolError(
    "input_unsupported",
    `The tool "${tool}" needs a sign-in to ${names.map((name) => `"${name}"`).join(", ")}, and this client did not declare URL elicitation.`,
  );
}

function approvalRequest(callId: string, tool: string, requestState: string): McpToolCallResult {
  return {
    _meta: { [MCP_APPROVAL_KEY]: { callId, tool } },
    inputRequests: {
      [MCP_APPROVAL_KEY]: {
        method: "elicitation/create",
        params: {
          message: `Allow the tool "${tool}" to run?`,
          mode: "form",
          requestedSchema: {
            properties: { approved: { title: "Approve", type: "boolean" } },
            required: ["approved"],
            type: "object",
          },
        },
      },
    },
    requestState,
    resultType: "input_required",
  };
}

function authorizationRequest(
  callId: string,
  signIns: readonly McpRequestStateSignIn[],
  requestState: string,
): McpToolCallResult {
  return {
    _meta: {
      [MCP_AUTHORIZATION_META_KEY]: { callId, connections: signIns.map((entry) => entry.name) },
    },
    inputRequests: Object.fromEntries(
      signIns.map((entry) => [
        `${MCP_AUTHORIZATION_KEY_PREFIX}${entry.name}`,
        {
          method: "elicitation/create",
          params: { message: signInMessage(entry), mode: "url", url: entry.url },
        },
      ]),
    ),
    requestState,
    resultType: "input_required",
  };
}

function statePayload(
  context: McpToolsContext,
  call: {
    readonly args: unknown;
    readonly carriedApproval: { readonly approved: boolean } | undefined;
    readonly key: string | undefined;
    readonly name: string;
  },
  kind: McpRequestStatePayload["kind"],
  callId: string,
  oneOffNonce: string | undefined,
): McpRequestStatePayload {
  let sid: string;
  let nonce: string | undefined;
  if (call.key !== undefined) {
    sid = sessionIdFor(context.principals, { kind: "key", value: call.key });
  } else {
    // Core returns the nonce for every one-off pause; without it no retry
    // could reach the same session.
    if (oneOffNonce === undefined) {
      throw new Error("invokeTool paused a one-off call without returning its nonce.");
    }
    nonce = oneOffNonce;
    sid = sessionIdFor(context.principals, { kind: "one-off", nonce });
  }
  const payload: { -readonly [K in keyof McpRequestStatePayload]: McpRequestStatePayload[K] } = {
    args: hashToolArguments(call.args),
    callId,
    kind,
    sid,
    tool: call.name,
    v: 1,
  };
  if (nonce !== undefined) payload.nonce = nonce;
  // A sign-in round carries the approval answer that led to it, so the
  // client does not answer twice. Core still re-runs the policy.
  if (kind === "authorization" && call.carriedApproval !== undefined) {
    payload.approval = call.carriedApproval;
  }
  return payload;
}

function signInMessage(entry: McpRequestStateSignIn): string {
  const code = entry.userCode === undefined ? "" : ` Code: ${entry.userCode}`;
  return `Sign in to ${entry.name} to continue.${code}`;
}

/**
 * Whether the request's declared client capabilities cover an elicitation
 * mode, by the SDK's own rule: `elicitation: {}` implies form, URL must be
 * named. Checked before minting so the client gets a tool error, not the
 * SDK's `-32021`, and nothing is signed for a client that cannot answer.
 */
function clientSupports(
  server: McpServer,
  context: McpToolsContext,
  ctx: McpRequestHandlerExtra,
  mode: "form" | "url",
): boolean {
  const declared = declaredCapabilities(server, context, ctx);
  if (declared === undefined) return false;
  const elicitation = declared.elicitation;
  if (!isJsonObject(elicitation)) return false;
  if (mode === "url") return elicitation.url !== undefined;
  return elicitation.form !== undefined || elicitation.url === undefined;
}

/** The client capabilities this request declared: per request in the modern era, else from `initialize`. */
function declaredCapabilities(
  server: McpServer,
  context: McpToolsContext,
  ctx: McpRequestHandlerExtra,
): McpJsonObject | undefined {
  const declared =
    context.era === "modern"
      ? ctx.mcpReq.envelope?.[CLIENT_CAPABILITIES_META_KEY]
      : server.server.getClientCapabilities();
  return isJsonObject(declared) ? declared : undefined;
}

function toolError(
  code: McpToolErrorCode,
  message: string,
  errorId?: string,
): Extract<McpToolCallResult, { readonly content: unknown }> {
  const text = errorId === undefined ? message : `${message} (errorId: ${errorId})`;
  const error: Record<string, unknown> = { code, message, retryable: false };
  if (errorId !== undefined) error.errorId = errorId;
  return { content: [{ text, type: "text" }], isError: true, structuredContent: { error } };
}

/** Maps a tool's model output onto MCP content blocks. */
export function toContent(output: ToolModelOutput): readonly McpContentBlock[] {
  switch (output.type) {
    case "text":
      return [{ text: output.value, type: "text" }];
    case "json":
      return [{ text: JSON.stringify(output.value) ?? "null", type: "text" }];
    case "content":
      return output.value.map((part, index): McpContentBlock => {
        if (part.type === "text") return { text: part.text, type: "text" };
        if (part.mediaType.startsWith("image/")) {
          return { data: part.data.data, mimeType: part.mediaType, type: "image" };
        }
        if (part.mediaType.startsWith("audio/")) {
          return { data: part.data.data, mimeType: part.mediaType, type: "audio" };
        }
        const name = encodeURIComponent(part.filename ?? `part-${index}`);
        return {
          resource: {
            blob: part.data.data,
            mimeType: part.mediaType,
            uri: `eve-tool-output:${name}`,
          },
          type: "resource",
        };
      });
  }
}

function isJsonObject(value: unknown): value is McpJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
