import type { SessionAuthContext } from "#channel/types.js";
import type { InputPrincipal } from "#shared/input.js";

/**
 * The principal an auth context identifies, or `undefined` when it identifies
 * no one: an unauthenticated or anonymous caller can't be told apart from
 * another, so it can't own a request.
 */
export function inputPrincipalOf(
  auth: SessionAuthContext | null | undefined,
): InputPrincipal | undefined {
  if (auth === null || auth === undefined || auth.principalType === "anonymous") return undefined;
  return {
    authenticator: auth.authenticator,
    ...(auth.issuer !== undefined && { issuer: auth.issuer }),
    principalId: auth.principalId,
    principalType: auth.principalType,
  };
}

/** Whether `responder` may answer a request that only `answerableBy` may answer. */
export function mayAnswerInputRequest(
  answerableBy: InputPrincipal | undefined,
  responder: SessionAuthContext | null | undefined,
): boolean {
  if (answerableBy === undefined) return true;
  const principal = inputPrincipalOf(responder);
  return (
    principal !== undefined &&
    principal.authenticator === answerableBy.authenticator &&
    principal.issuer === answerableBy.issuer &&
    principal.principalId === answerableBy.principalId &&
    principal.principalType === answerableBy.principalType
  );
}
