import { buildCallbackContext } from "#context/build-callback-context.js";
import {
  buildApprovalResponseAuth,
  handleApprovalResponsePolicyError,
} from "#execution/tool-auth.js";
import { isAuthorizationSignal } from "#harness/authorization.js";
import type { HumanInputEvent, Intake } from "#harness/human-input/index.js";
import type { HarnessToolMap } from "#harness/types.js";

const POLICY_TIMEOUT_MS = 10_000;
const UNAVAILABLE_REASON = "Approval authorization is temporarily unavailable. Please try again.";

/**
 * Runs the `approval.response` policy for one responder's answer and reports
 * its verdict. A policy that throws, times out, or answers with anything but
 * allowed or rejected fails the candidate; one that needs the responder to
 * sign in reports the sign-in, scoped to the candidate, so each candidate's
 * sign-in settles only its own answer.
 */
export async function checkResponder(
  check: Extract<HumanInputEvent, { readonly type: "responder.check" }>,
  tools: HarnessToolMap,
): Promise<Extract<Intake, { readonly type: "responder.checked" }>> {
  const { candidateId, request } = check;
  const approval = tools.get(request.action.toolName)?.approval;
  const policy =
    approval !== undefined && typeof approval !== "function" ? approval.response : undefined;
  if (policy === undefined) {
    return {
      candidateId,
      reason: UNAVAILABLE_REASON,
      type: "responder.checked",
      verdict: "failed",
    };
  }
  try {
    const context = buildCallbackContext();
    const outcome = await withTimeout(
      policy({
        auth: buildApprovalResponseAuth({ responder: check.responder, scope: candidateId }),
        request: {
          callId: request.action.callId,
          principal: check.requester,
          requestId: request.requestId,
          toolInput: request.action.input,
          toolName: request.action.toolName,
        },
        response: { decision: check.decision, principal: check.responder },
        session: {
          id: context.session.id,
          initiator: context.session.auth.initiator,
          parent: context.session.parent,
          turn: context.session.turn,
        },
      }),
    );
    if (outcome.status === "allowed") {
      return { candidateId, type: "responder.checked", verdict: "allowed" };
    }
    if (outcome.status === "rejected") {
      return {
        candidateId,
        reason: outcome.reason,
        type: "responder.checked",
        verdict: "rejected",
      };
    }
    return { candidateId, type: "responder.checked", verdict: "failed" };
  } catch (error) {
    const signIn = await handleApprovalResponsePolicyError(error).catch(() => undefined);
    if (isAuthorizationSignal(signIn)) {
      return {
        candidateId,
        challenges: signIn.challenges,
        type: "responder.checked",
        verdict: "authorization-required",
      };
    }
    return { candidateId, type: "responder.checked", verdict: "failed" };
  }
}

async function withTimeout<T>(value: Promise<T> | T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Approval response policy timed out.")),
          POLICY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
