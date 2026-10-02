import type { SessionAuthContext } from "#channel/types.js";
import type { ConnectionAuthorizationChallenge } from "#connections/errors.js";
import type { ToolModelOutput } from "#tools/model-output.js";

/** Longest tool session key a caller may send. */
export const TOOL_SESSION_KEY_MAX_LENGTH = 512;

/** Options for one {@link InvokeToolFn} call. */
export interface InvokeToolOptions {
  /** The caller this request authenticated. Becomes `ctx.session.auth.current`. */
  readonly auth: SessionAuthContext;
  /**
   * The transport principal that forwarded `auth`, when the channel accepted a
   * forwarded identity from a trusted forwarder. Part of the tool session id, so
   * the same user behind two forwarders gets two sessions.
   */
  readonly forwarder?: SessionAuthContext;
  /** The initiator the request asserts. Defaults to `auth`. */
  readonly initiator?: SessionAuthContext;
  /**
   * The caller's name for its tool session, at most 512 characters. Calls with
   * the same key, caller, and forwarder share one sandbox. Omit for a one-off
   * session whose sandbox is deleted when the call ends.
   */
  readonly key?: string;
  /**
   * The one-off nonce a previous attempt of this call returned, so a retry
   * derives the same one-off session id. Ignored when `key` is set.
   */
  readonly oneOffNonce?: string;
  /** Correlates the retries of one call, at most 512 characters. Minted when absent. */
  readonly callId?: string;
  /**
   * The person's answer to this call's approval, when the caller has one. The
   * tool's response policy still runs with the caller as the responder.
   * `invokeTool` does not tie the answer to `input` or `callId`: a caller
   * that relays answers across requests must bind them itself, for example
   * with signed state over the tool name and arguments.
   */
  readonly approval?: { readonly approved: boolean };
  readonly signal?: AbortSignal;
}

/** One sign-in the caller must complete before retrying the call. */
export interface InvokeToolAuthorizationChallenge {
  /** Connection name, or the tool name for tool-hosted sign-in. */
  readonly name: string;
  readonly challenge: ConnectionAuthorizationChallenge;
}

/** How the call reached its tool session's sandbox, present when the call opened it. */
export interface InvokeToolSandboxReport {
  /** `created` new, `resumed` from a stopped sandbox, or `reused` a running one. */
  readonly state: "created" | "resumed" | "reused";
  /** Milliseconds spent opening the sandbox. */
  readonly ms: number;
}

/** Outcome of one {@link InvokeToolFn} call. */
export type InvokeToolResult = (
  | {
      readonly status: "completed";
      readonly output: unknown;
      readonly modelOutput: ToolModelOutput;
    }
  | { readonly status: "failed"; readonly message: string; readonly errorId: string }
  | { readonly status: "invalid-input"; readonly message: string }
  | { readonly status: "denied"; readonly reason?: string }
  | {
      readonly status: "approval-required";
      readonly callId: string;
      /** Present for a one-off session; pass it back as `oneOffNonce` on the retry. */
      readonly oneOffNonce?: string;
    }
  | {
      readonly status: "authorization-required";
      readonly callId: string;
      readonly challenges: readonly InvokeToolAuthorizationChallenge[];
      /** Present for a one-off session; pass it back as `oneOffNonce` on the retry. */
      readonly oneOffNonce?: string;
    }
) & {
  readonly sandbox?: InvokeToolSandboxReport;
};

/**
 * Runs one of the agent's tools outside a conversation, in a tool session: the
 * caller's identity plus a sandbox reused across calls with the same key.
 * No model, turn, or workflow step is involved, and the call never parks.
 */
export type InvokeToolFn = (
  name: string,
  input: unknown,
  options: InvokeToolOptions,
) => Promise<InvokeToolResult>;
