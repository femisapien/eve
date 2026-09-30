import { asSchema } from "ai";

import { resolveApprovalPolicy, type ApprovalStatus } from "#approval/definition.js";
import type {
  InvokeToolAuthorizationChallenge,
  InvokeToolOptions,
  InvokeToolResult,
} from "#channel/invoke-tool.js";
import {
  compiledToolOwner,
  type CompiledToolBindings,
  isInvocableCompiledTool,
} from "#channel/tool-eligibility.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { CompiledToolDefinition } from "#compiler/manifest.js";
import { isConnectionAuthorizationFailedError } from "#connections/errors.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  AuthKey,
  InitiatorAuthKey,
  SandboxKey,
  SessionIdKey,
  SessionKey,
  ToolSessionKey,
} from "#context/keys.js";
import {
  buildApprovalResponseAuth,
  handleApprovalResponsePolicyError,
} from "#execution/tool-auth.js";
import {
  createToolSessionOneOffNonce,
  deriveToolSessionId,
  validateToolSessionKey,
} from "#execution/tool-session/id.js";
import { createToolSessionSandbox } from "#execution/tool-session/sandbox.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  type AuthorizationSignal,
  AuthorizationHookKey,
  CallbackBaseUrlKey,
  isAuthorizationSignal,
} from "#harness/authorization.js";
import { normalizeToolJsonOutput, normalizeToolModelOutput } from "#harness/tool-model-output.js";
import type { HarnessToolMap } from "#harness/types.js";
import { createErrorId, createLogger, logError } from "#internal/logging.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { CompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { toErrorMessage } from "#shared/errors.js";
import { isObject } from "#shared/guards.js";
import { createUlid } from "#shared/ulid.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import type { ToolModelOutput } from "#tools/model-output.js";

const log = createLogger("tool-session");

/** What `invokeTool` needs from the agent: its static tools and sandbox. */
export interface ToolSessionRuntime {
  /** Present in a deployed agent so framework tools can reach the compiled graph. */
  readonly bundle?: CompiledRuntimeAgentBundle;
  /** Base URL for framework callbacks, such as the page a sign-in lands on. */
  readonly callbackBaseUrl: string;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  /** The root node's compiled tools and source bindings, which decide invocability. */
  readonly manifest: ToolSessionManifest;
  readonly nodeId: string;
  readonly sandboxRegistry: RuntimeSandboxRegistry;
  /** Static tools only: dynamic resolvers never run in a tool session. */
  readonly tools: HarnessToolMap;
}

/** The part of a compiled manifest `invokeTool` reads to decide invocability. */
export interface ToolSessionManifest extends CompiledToolBindings {
  readonly tools: readonly Pick<
    CompiledToolDefinition,
    "behavior" | "hasExecute" | "name" | "sourceId"
  >[];
}

type WithoutSandbox<T> = T extends unknown ? Omit<T, "sandbox"> : never;
type CallOutcome = WithoutSandbox<InvokeToolResult>;

/** Why a compiled tool cannot run in a tool session, or `undefined` when it can. */
export function toolSessionIneligibility(
  manifest: ToolSessionManifest,
  tool: ToolSessionManifest["tools"][number],
): string | undefined {
  // `isInvocableCompiledTool` is the one rule, shared with `describe()`; the
  // reason below only words the refusal.
  if (isInvocableCompiledTool(manifest, tool)) return undefined;
  if (compiledToolOwner(manifest, tool).kind === "framework") {
    return "it is a framework tool, which needs a conversation's harness, sandbox, or session";
  }
  if (tool.behavior?.handling !== undefined) {
    return "the harness or the model provider runs it, not its execute";
  }
  return "it has no server-side execute";
}

/**
 * Runs one tool in a tool session. See `InvokeToolFn` for the contract; the
 * outline is: derive the session id, validate input, evaluate approval on this
 * call alone, execute with a turn-shaped `ctx`, and release a one-off sandbox.
 */
export async function invokeToolInSession(
  runtime: ToolSessionRuntime,
  name: string,
  input: unknown,
  options: InvokeToolOptions,
): Promise<InvokeToolResult> {
  const callId = options.callId ?? `call_${createUlid()}`;
  if (options.key !== undefined) {
    const problem = validateToolSessionKey(options.key);
    if (problem !== undefined) return { message: problem, status: "invalid-input" };
  }
  if (options.key === undefined && options.oneOffNonce !== undefined) {
    const problem = validateToolSessionKey(options.oneOffNonce);
    if (problem !== undefined) {
      return {
        message: problem.replace("tool session key", "one-off nonce"),
        status: "invalid-input",
      };
    }
  }

  const compiled = runtime.manifest.tools.find((tool) => tool.name === name);
  const definition = runtime.tools.get(name);
  if (compiled === undefined || definition === undefined) {
    return failed(`The agent has no tool named "${name}".`);
  }
  const ineligible =
    toolSessionIneligibility(runtime.manifest, compiled) ??
    (definition.execute === undefined ? "it has no server-side execute" : undefined);
  if (ineligible !== undefined) {
    return failed(`Tool "${name}" cannot be invoked outside a conversation: ${ineligible}.`);
  }

  const validated = await validateToolInput(definition, input);
  if (!validated.success) return { message: validated.message, status: "invalid-input" };

  const oneOffNonce =
    options.key === undefined ? (options.oneOffNonce ?? createToolSessionOneOffNonce()) : undefined;
  const sessionId = deriveToolSessionId({
    current: options.auth,
    forwarder: options.forwarder,
    key:
      oneOffNonce === undefined
        ? { kind: "key", value: options.key! }
        : { kind: "one-off", nonce: oneOffNonce },
  });

  const sandbox = await createToolSessionSandbox({
    compiledArtifactsSource: runtime.compiledArtifactsSource,
    nodeId: runtime.nodeId,
    registry: runtime.sandboxRegistry,
    sessionId,
  });
  const context = createToolSessionContext({
    auth: options.auth,
    callId,
    callbackBaseUrl: runtime.callbackBaseUrl,
    initiator: options.initiator ?? options.auth,
    sessionId,
    toolName: name,
  });
  context.setVirtualContext(SandboxKey, sandbox.access);
  if (runtime.bundle !== undefined) context.setVirtualContext(BundleKey, runtime.bundle);

  let outcome: CallOutcome;
  try {
    outcome = await contextStorage.run(context, () =>
      runCall({
        callId,
        definition,
        input: validated.value,
        options,
      }),
    );
  } finally {
    try {
      await sandbox.release({ oneOff: oneOffNonce !== undefined });
    } catch (error) {
      logError(log, "failed to delete a one-off tool-session sandbox", error, {
        sessionId,
        toolName: name,
      });
    }
  }

  const result: InvokeToolResult =
    oneOffNonce !== undefined &&
    (outcome.status === "approval-required" || outcome.status === "authorization-required")
      ? { ...outcome, oneOffNonce }
      : outcome;
  const report = sandbox.report();
  return report === undefined ? result : { ...result, sandbox: report };
}

function createToolSessionContext(input: {
  readonly auth: SessionAuthContext;
  readonly callId: string;
  readonly callbackBaseUrl: string;
  readonly initiator: SessionAuthContext;
  readonly sessionId: string;
  readonly toolName: string;
}): ContextContainer {
  const context = new ContextContainer();
  context.set(AuthKey, input.auth);
  context.set(InitiatorAuthKey, input.initiator);
  context.set(SessionIdKey, input.sessionId);
  // No turn exists; the stand-in names the call, as sandbox setup outside a turn does.
  context.setVirtualContext(SessionKey, {
    auth: { current: input.auth, initiator: input.initiator },
    sessionId: input.sessionId,
    turn: { id: input.callId, sequence: 0 },
  });
  context.setVirtualContext(ToolSessionKey, { toolName: input.toolName });
  context.set(CallbackBaseUrlKey, input.callbackBaseUrl.replace(/\/$/, ""));
  // Sign-in callbacks have no parked run to resume; the URL is only a landing page.
  context.setVirtualContext(AuthorizationHookKey, `tool-session:${input.callId}`);
  return context;
}

async function runCall(input: {
  readonly callId: string;
  readonly definition: HarnessToolDefinition;
  readonly input: unknown;
  readonly options: InvokeToolOptions;
}): Promise<CallOutcome> {
  const { callId, definition, options } = input;
  const signal = options.signal ?? new AbortController().signal;

  if (definition.approval !== undefined) {
    let status: NormalizedApproval;
    try {
      status = normalizeApprovalStatus(
        await resolveApprovalPolicy(definition.approval)({
          ...buildCallbackContext(),
          abortSignal: signal,
          approvedTools: new Set<string>(),
          callId,
          toolInput: isObject(input.input) ? input.input : undefined,
          toolName: definition.name,
        }),
      );
    } catch (error) {
      return failedFromError(error, definition.name, "approval policy failed");
    }
    if (status.kind === "denied") return denied(status.reason);
    if (status.kind === "user-approval") {
      if (options.approval === undefined) return { callId, status: "approval-required" };
      const answered = await authorizeApprovalAnswer({
        approved: options.approval.approved,
        callId,
        definition,
        input: input.input,
        responder: options.auth,
      });
      if (answered !== undefined) return answered;
    }
  }

  const executeOptions: ToolExecuteOptions = {
    abortSignal: signal,
    messages: [],
    toolCallId: callId,
  };
  let output: unknown;
  try {
    output = await definition.execute!(input.input, executeOptions);
    if (isAsyncIterable(output)) output = await lastIterated(output);
  } catch (error) {
    if (isConnectionAuthorizationFailedError(error)) {
      return failed(toErrorMessage(error));
    }
    return failedFromError(error, definition.name, "tool execution failed");
  }
  if (isAuthorizationSignal(output)) return authorizationRequired(output, callId);

  try {
    const json = normalizeToolJsonOutput({
      boundary: "execute",
      output,
      toolCallId: callId,
      toolName: definition.name,
    });
    return {
      modelOutput: await toModelOutput(definition, json, callId),
      output: json,
      status: "completed",
    };
  } catch (error) {
    return failedFromError(error, definition.name, "tool output could not be serialized");
  }
}

type NormalizedApproval =
  | { readonly kind: "run" }
  | { readonly kind: "user-approval" }
  | { readonly kind: "denied"; readonly reason?: string };

function normalizeApprovalStatus(status: ApprovalStatus): NormalizedApproval {
  if (status === true || status === "user-approval") return { kind: "user-approval" };
  if (status === "denied") return { kind: "denied" };
  if (typeof status === "object" && status !== null) {
    if (status.type === "user-approval") return { kind: "user-approval" };
    if (status.type === "denied") return { kind: "denied", reason: status.reason };
  }
  return { kind: "run" };
}

/**
 * Evaluates the caller's answer with the tool's response policy, the check a
 * conversation runs when a response is delivered. Returns the outcome that
 * stops the call, or `undefined` when the tool may run. Nothing from earlier
 * calls counts: `callId` only correlates retries and never grants approval.
 */
async function authorizeApprovalAnswer(input: {
  readonly approved: boolean;
  readonly callId: string;
  readonly definition: HarnessToolDefinition;
  readonly input: unknown;
  readonly responder: SessionAuthContext;
}): Promise<CallOutcome | undefined> {
  const approval = input.definition.approval;
  const responsePolicy =
    approval !== undefined && typeof approval !== "function" ? approval.response : undefined;
  if (responsePolicy !== undefined) {
    const context = buildCallbackContext();
    try {
      const decision = await responsePolicy({
        auth: buildApprovalResponseAuth({ responder: input.responder, scope: input.callId }),
        request: {
          callId: input.callId,
          principal: input.responder,
          requestId: input.callId,
          toolInput: isObject(input.input) ? input.input : undefined,
          toolName: input.definition.name,
        },
        response: {
          decision: input.approved ? "approve" : "cancel",
          principal: input.responder,
        },
        session: {
          id: context.session.id,
          initiator: context.session.auth.initiator,
          turn: context.session.turn,
        },
      });
      // A tool session has no pending request to leave for another responder.
      if (decision.status === "rejected") return denied(decision.reason);
      if (decision.status !== "allowed") {
        return failed(
          `The approval response policy of tool "${input.definition.name}" returned an unknown decision.`,
        );
      }
    } catch (error) {
      const authorization = await handleApprovalResponsePolicyError(error).catch(() => undefined);
      if (isAuthorizationSignal(authorization)) {
        return authorizationRequired(authorization, input.callId);
      }
      return failedFromError(error, input.definition.name, "approval response policy failed");
    }
  }
  return input.approved ? undefined : denied("The person declined this call.");
}

function authorizationRequired(signal: AuthorizationSignal, callId: string): CallOutcome {
  // A `resume` value must be kept until the callback arrives, and a tool session keeps nothing.
  const stateful = signal.challenges.find((challenge) => challenge.resume !== undefined);
  if (stateful !== undefined) {
    return failed(
      `Connection "${stateful.name}" cannot sign in from a tool session: its sign-in strategy returns ` +
        "`resume` state from `startAuthorization`, which a tool session has nowhere to keep until the " +
        "callback arrives. Use a strategy whose provider runs the OAuth flow, such as Vercel Connect.",
    );
  }
  const challenges: InvokeToolAuthorizationChallenge[] = signal.challenges.map((challenge) => ({
    challenge: challenge.challenge,
    name: challenge.name,
  }));
  return { callId, challenges, status: "authorization-required" };
}

async function validateToolInput(
  definition: HarnessToolDefinition,
  input: unknown,
): Promise<
  | { readonly success: true; readonly value: unknown }
  | { readonly success: false; readonly message: string }
> {
  const schema = asSchema(definition.inputSchema);
  if (schema.validate === undefined) return { success: true, value: input };
  try {
    const result = await schema.validate(input);
    return result.success
      ? { success: true, value: result.value }
      : {
          message: `Invalid input for tool "${definition.name}": ${toErrorMessage(result.error)}`,
          success: false,
        };
  } catch (error) {
    return {
      message: `Invalid input for tool "${definition.name}": ${toErrorMessage(error)}`,
      success: false,
    };
  }
}

async function toModelOutput(
  definition: HarnessToolDefinition,
  output: unknown,
  callId: string,
): Promise<ToolModelOutput> {
  if (definition.toModelOutput !== undefined) {
    return normalizeToolModelOutput({
      output: await definition.toModelOutput(output),
      toolCallId: callId,
      toolName: definition.name,
    }) as ToolModelOutput;
  }
  if (typeof output === "string") return { type: "text", value: output };
  return normalizeToolModelOutput({
    output: { type: "json", value: output ?? null },
    toolCallId: callId,
    toolName: definition.name,
  }) as ToolModelOutput;
}

async function lastIterated(iterable: AsyncIterable<unknown>): Promise<unknown> {
  let last: unknown;
  for await (const value of iterable) last = value;
  return last;
}

function denied(reason: string | undefined): CallOutcome {
  return reason === undefined ? { status: "denied" } : { reason, status: "denied" };
}

function failed(message: string): CallOutcome {
  return { errorId: createErrorId(), message, status: "failed" };
}

function failedFromError(error: unknown, toolName: string, what: string): CallOutcome {
  const errorId = logError(log, `tool session ${what}`, error, { toolName });
  return { errorId, message: toErrorMessage(error), status: "failed" };
}
