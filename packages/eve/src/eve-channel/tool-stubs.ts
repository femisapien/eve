import { RunExpiredError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { EveChannelInput } from "#eve-channel/types.js";
import { invocationOwnerKey } from "#internal/invocation/metadata.js";
import { getWorld } from "#internal/workflow/runtime.js";
import { STUB_OWNER_ATTRIBUTE } from "#tool-stubs/types.js";

export async function authorizeToolStubs(
  config: EveChannelInput,
  auth: SessionAuthContext,
): Promise<Response | undefined> {
  if ((await config.allowToolStubs?.(auth)) === true) return undefined;
  return Response.json(
    { ok: false, error: "Tool stubbing is not permitted for this caller." },
    { status: 403 },
  );
}

/** Reads immutable run attributes, including for children and completed sessions. */
export async function authorizeStubbedSession(
  config: EveChannelInput,
  auth: SessionAuthContext,
  sessionId: string,
): Promise<Response | undefined> {
  let owner: string | undefined;
  try {
    owner = (await (await getWorld()).runs.get(sessionId)).attributes?.[STUB_OWNER_ATTRIBUTE];
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
    throw error;
  }
  if (owner === undefined) return undefined;
  if (owner !== invocationOwnerKey(auth)) {
    return Response.json({ ok: false, error: "Session not found." }, { status: 404 });
  }
  return await authorizeToolStubs(config, auth);
}
