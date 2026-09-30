import { createHash } from "node:crypto";

import type { SessionAuthContext } from "#channel/types.js";

/** Fixed-width fingerprint of a principal, used as the provider safety identifier. */
export function invocationOwnerKey(auth: SessionAuthContext | null): string {
  const identity =
    auth === null
      ? ["anonymous"]
      : [
          auth.authenticator,
          auth.issuer ?? "",
          auth.principalType,
          auth.principalId,
          auth.subject ?? "",
        ];
  return createHash("sha256").update(JSON.stringify(identity), "utf8").digest("hex");
}
