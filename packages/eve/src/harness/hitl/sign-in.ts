import type { ModelMessage, TypedToolResult, ToolSet } from "ai";
import { authorizationEventFields } from "#harness/authorization-event-fields.js";
import {
  getSupersededAuthorizationChallenges,
  setPendingAuthorization,
} from "#harness/authorization.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import { resolveInlineAuthorizationInterrupt } from "#harness/inline-tool-authorization.js";
import { validateHarnessModelMessages } from "#harness/messages.js";
import type { Step } from "#harness/step/context.js";
import type { StepResult } from "#harness/types.js";
import {
  createAuthorizationCompletedEvent,
  createAuthorizationRequiredEvent,
} from "#protocol/message.js";
import { holdForInput } from "./intake.js";
/**
 * A call the model step ran needs a sign-in: the turn holds until it completes, and supersedes the
 * attempts it replaces.
 */
export async function stopForToolSignIn(
  step: Step,
  input: {
    readonly messages: readonly ModelMessage[];
    readonly position: HarnessEmissionState;
    readonly toolResults: readonly TypedToolResult<ToolSet>[] | undefined;
  },
): Promise<StepResult | undefined> {
  const interrupt = resolveInlineAuthorizationInterrupt({
    messages: [...input.messages],
    toolResults: input.toolResults,
  });
  if (!interrupt) return undefined;
  const { challenges } = interrupt;
  const { sequence, stepIndex, turnId } = input.position;
  if (step.emit !== undefined) {
    for (const superseded of getSupersededAuthorizationChallenges(step.session.state, challenges)) {
      await step.emit(
        createAuthorizationCompletedEvent({
          ...authorizationEventFields(superseded),
          outcome: "failed",
          reason: "Superseded by a newer authorization attempt.",
          sequence,
          stepIndex,
          turnId,
        }),
      );
    }
    for (const challenge of challenges) {
      await step.emit(
        createAuthorizationRequiredEvent({
          ...authorizationEventFields(challenge),
          description:
            challenge.challenge.instructions ?? `Authorization required for ${challenge.name}`,
          sequence,
          stepIndex,
          turnId,
          webhookUrl: challenge.hookUrl,
        }),
      );
    }
  }
  step.session = {
    ...step.session,
    history: validateHarnessModelMessages(interrupt.history),
    state: setPendingAuthorization(step.session.state, { challenges }),
  };
  await holdForInput(step, input.position);
  return { held: { kind: "request" }, next: null, session: step.session };
}
