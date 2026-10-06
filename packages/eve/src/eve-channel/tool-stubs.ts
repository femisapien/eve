import type { SessionAuthContext } from "#channel/types.js";
import { areTokenClaimMatchersSatisfied } from "#channel/auth/token-claims.js";
import type { EveChannelInput } from "#eve-channel/types.js";

export async function authorizeToolStubs(
  config: EveChannelInput,
  auth: SessionAuthContext,
): Promise<Response | undefined> {
  const policy = config.allowToolStubs;
  const allowed =
    typeof policy === "function"
      ? await policy(auth)
      : areTokenClaimMatchersSatisfied({ sub: auth.subject }, { subjects: policy?.subjects ?? [] });
  if (allowed === true) return undefined;
  return Response.json(
    { ok: false, error: "Tool stubbing is not permitted for this caller." },
    { status: 403 },
  );
}
