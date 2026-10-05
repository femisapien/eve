import type { JsonObject, JsonValue } from "#shared/json.js";

/** A JSON response selected by tool name and partial argument constraints. */
export type ToolStub = {
  readonly id: string;
  readonly tool: string;
  /** Each named input property must exist and satisfy its JSON Schema. */
  readonly match?: Readonly<Record<string, JsonObject | boolean>>;
} & (
  | { readonly response: JsonValue; readonly responses?: never }
  | { readonly response?: never; readonly responses: readonly [JsonValue, ...JsonValue[]] }
);

export interface StubCall {
  /** Includes the originating session, turn, and tool call identities. */
  readonly callId: string;
  readonly tool: string;
  readonly input: unknown;
  readonly persistent?: boolean;
}

export type StubResult =
  | { readonly kind: "real" }
  | { readonly kind: "error"; readonly error: string }
  | {
      readonly kind: "stub";
      readonly ruleId: string;
      readonly position: number;
      readonly response: JsonValue;
    };

/** Trusted server metadata, never read from a client-supplied session identifier. */
export interface StubScope {
  readonly owner: string;
  readonly token: string;
  readonly rules: readonly ToolStub[];
  readonly rootSessionId?: string;
}

export const STUB_CONTEXT_KEY = "eve.toolStubs";
export const STUB_OWNER_ATTRIBUTE = "$eve.stubOwner";
export const STUB_FAILURE_NAMESPACE = "eve.tool-stubs.failure";
export const stubResponseNamespace = (callId: string): string => `eve.tool-stubs.${callId}`;
