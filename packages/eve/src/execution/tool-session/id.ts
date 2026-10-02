import { createHash, randomBytes } from "node:crypto";

import { TOOL_SESSION_KEY_MAX_LENGTH } from "#channel/invoke-tool.js";
import type { SessionAuthContext } from "#channel/types.js";

/** Why a tool session key was refused, or `undefined` when it is usable. */
export function validateToolSessionKey(
  key: string,
  label = "tool session key",
): string | undefined {
  if (key.length === 0) return `The ${label} must not be empty.`;
  if (key.length > TOOL_SESSION_KEY_MAX_LENGTH) {
    return `The ${label} must be at most ${TOOL_SESSION_KEY_MAX_LENGTH} characters.`;
  }
  return undefined;
}

/** Mints the random nonce that names one one-off tool session. */
export function createToolSessionOneOffNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Derives a tool session id as `sha256(forwarder, auth.current, key)`.
 *
 * Nothing is stored: every call recomputes the id from its own authenticated
 * principals, so no other caller, and no other user behind the same forwarder,
 * reaches the session. One-off sessions use `"one-off:" + nonce` as the key.
 */
export function deriveToolSessionId(input: {
  readonly current: SessionAuthContext;
  readonly forwarder?: SessionAuthContext;
  readonly key:
    | { readonly kind: "key"; readonly value: string }
    | { readonly kind: "one-off"; readonly nonce: string };
}): string {
  const key = input.key.kind === "key" ? input.key.value : `one-off:${input.key.nonce}`;
  const encoded = JSON.stringify([
    "eve.tool-session.v1",
    input.forwarder === undefined ? null : principalIdentity(input.forwarder),
    principalIdentity(input.current),
    key,
  ]);
  return `ts_${createHash("sha256").update(encoded, "utf8").digest("hex")}`;
}

// Same identity fields as `invocationOwnerKey`; attributes are not identity.
function principalIdentity(auth: SessionAuthContext): readonly string[] {
  return [
    auth.authenticator,
    auth.issuer ?? "",
    auth.principalType,
    auth.principalId,
    auth.subject ?? "",
  ];
}
