import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import type { AuthorizationChallenge } from "#harness/authorization.js";
import type { SessionStateMap, StepInput } from "#harness/types.js";
import {
  HumanInput,
  reduceHumanInput,
  type Command,
  type InputOf,
  type Input,
  type Next,
  type PolicyCheck,
  type PolicyRun,
  type RequestAt,
} from "#harness/hitl/index.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeWorkflowTaskRequest } from "#shared/action-types.js";
import type { InputRequest, InputResponse } from "#shared/input.js";

/** Scenario builders for the `HumanInput` rule tests, which read as given, when, then. */

/** Where Alice's turn asked: its first model step. */
export const AT: RequestAt = { sequence: 1, stepIndex: 0, turnId: "turn_1" };
/** When answers arrive, unless a test moves the clock. */
export const NOW = 1_000_000;

function person(principalId: string): SessionAuthContext {
  return { attributes: {}, authenticator: "test", principalId, principalType: "user" };
}

/** Alice started the turn; Bob and Carol are other people in the conversation. */
export const ALICE = person("alice");
export const BOB = person("bob");
export const CAROL = person("carol");

type Published<T extends UnstampedMessageStreamEvent["type"]> = Extract<
  UnstampedMessageStreamEvent,
  { type: T }
>;

/** A turn's human input, and the events the last thing that happened to it reported. */
export class Turn {
  readonly state: SessionStateMap | undefined;
  readonly events: readonly Command[];

  private constructor(state: SessionStateMap | undefined, events: readonly Command[]) {
    this.state = state;
    this.events = events;
  }

  /** A turn that waits on nobody. */
  static idle(): Turn {
    return new Turn(undefined, []);
  }

  /** A turn as a session stored it. */
  static from(state: SessionStateMap): Turn {
    return new Turn(state, []);
  }

  get humanInput(): HumanInput {
    return HumanInput.read(this.state);
  }

  /** The turn after the session sees `input`. */
  input(input: Input): Turn {
    const { events, state } = reduceHumanInput(this.state, input);
    return new Turn(state, events);
  }

  /** The calls a person approved that the turn has yet to run. */
  approvedCalls(): ReturnType<HumanInput["approvedCalls"]> {
    return this.humanInput.approvedCalls();
  }

  /**
   * The turn ran the calls a person approved, and they returned `results`;
   * `following` is the turn input that arrived with the answers.
   */
  ranApproved(results: readonly ModelMessage[] = [], following?: StepInput): Turn {
    return this.input({
      approved: following !== undefined ? { following } : {},
      results,
      type: "actions.settled",
    });
  }

  /** The response policies the runtime runs before it commits `input`. */
  checks(input: Input): readonly PolicyCheck[] {
    return this.humanInput.policyChecks(input as InputOf<"pre-step">);
  }

  /** `input`, committed once each response policy it needs did `ran`. */
  checked(input: Input, ran: PolicyRun): Turn {
    const verdicts = Object.fromEntries(
      this.checks(input).map((check) => [check.candidateId, ran]),
    );
    return this.input({ ...input, verdicts } as Input);
  }

  /** The same turn after the session stores it and reads it back, as between steps. */
  stored(): Turn {
    return new Turn(JSON.parse(JSON.stringify(this.state ?? null)) ?? undefined, this.events);
  }

  next(): Next {
    return this.humanInput.next();
  }

  /** The events of `type` the runtime is told to carry out. */
  reported<T extends Command["type"]>(type: T): Extract<Command, { type: T }>[] {
    return this.events.filter(
      (event): event is Extract<Command, { type: T }> => event.type === type,
    );
  }

  /** The stream events of `type` the runtime is told to publish. */
  published<T extends UnstampedMessageStreamEvent["type"]>(type: T): Published<T>[] {
    return this.reported("publish").flatMap((event) =>
      event.event.type === type ? [event.event as Published<T>] : [],
    );
  }

  /** Every request resolution published, in order. */
  resolutions(): Published<"input.resolved">["data"]["resolutions"][number][] {
    return this.published("input.resolved").flatMap((event) => event.data.resolutions);
  }

  /** The messages the runtime is told to add to history. */
  appended(): ModelMessage[] {
    return this.reported("appendHistory").map((event) => event.message);
  }

  /** Nothing is stored for the session once nothing is open. */
  storesNothing(): boolean {
    return this.state === undefined;
  }
}

/** The approval request for the call Alice's model step made to `toolName`. */
export function approval(toolName: string, requestId = toolName): InputRequest {
  return {
    action: { callId: `call-${requestId}`, input: {}, kind: "tool-call", toolName },
    allowFreeform: false,
    display: "confirmation",
    kind: "tool-approval",
    options: [
      { id: "approve", label: "Approve" },
      { id: "cancel", label: "Cancel" },
    ],
    prompt: `Alice asks to run ${toolName}.`,
    requestId,
  };
}

/** The response of Alice's model step that made the calls `requests` ask about. */
export function stepResponse(requests: readonly InputRequest[]): ModelMessage[] {
  return [
    {
      content: requests.flatMap((request) =>
        request.action === undefined
          ? []
          : [
              {
                input: request.action.input,
                toolCallId: request.action.callId,
                toolName: request.action.toolName,
                type: "tool-call" as const,
              },
            ],
      ),
      role: "assistant",
    },
  ];
}

/** Alice's model step made calls whose tools ask a person to approve them. */
export function approvalsRequested(
  requests: readonly InputRequest[],
  options: Partial<Extract<Input, { type: "approval.requested" }>> = {},
): Extract<Input, { type: "approval.requested" }> {
  return {
    approvalKeys: {},
    at: AT,
    messages: stepResponse(requests),
    requester: ALICE,
    requests,
    responsePolicyRequestIds: [],
    type: "approval.requested",
    ...options,
  };
}

/** A turn waiting because Alice's model step asked to run each of `toolNames`. */
export function waitingOnApprovals(...toolNames: string[]): Turn {
  return Turn.idle().input(approvalsRequested(toolNames.map((name) => approval(name))));
}

/** `responder` sends these answers at once, in this order. */
export function answered(
  responses: readonly InputResponse[],
  responder: SessionAuthContext | null = ALICE,
): Extract<Input, { type: "input.answered" }> {
  return { now: NOW, responder, responses, type: "input.answered" };
}

/** `responder` picks `optionId` for request `requestId`. */
export function answer(
  optionId: string,
  requestId: string,
  responder: SessionAuthContext | null = ALICE,
): Extract<Input, { type: "input.answered" }> {
  return answered([{ optionId, requestId }], responder);
}

/** Alice answers several requests at once, in this order. */
export function answers(
  byRequest: Readonly<Record<string, string>>,
): Extract<Input, { type: "input.answered" }> {
  return answered(
    Object.entries(byRequest).map(([requestId, optionId]) => ({ optionId, requestId })),
  );
}

/** `sender` types a message into the conversation. */
export function message(
  text: string,
  sender: SessionAuthContext | null = ALICE,
): Extract<Input, { type: "message.received" }> {
  return { sender, text, type: "message.received" };
}

export const cancel: Extract<Input, { type: "cancel.requested" }> = { type: "cancel.requested" };

/** The question a turn asks once its session runs over its input token budget. */
export const BUDGET_QUESTION: InputRequest = {
  action: { callId: "s:limit:input:12", input: {}, kind: "tool-call", toolName: "session-limit" },
  kind: "session-limit",
  options: [
    { id: "continue", label: "Approve" },
    { id: "stop", label: "Stop" },
  ],
  prompt: "Alice's session is over budget. Continue?",
  requestId: "s:limit:input:12",
};

/** The turn's next model call would run over the session's budget. */
export function overBudget(at: RequestAt = AT): Extract<Input, { type: "budget.exceeded" }> {
  return { at, request: BUDGET_QUESTION, type: "budget.exceeded" };
}

/** A turn waiting on the budget question. */
export function waitingOnBudget(): Turn {
  return Turn.idle().input(overBudget());
}

/** An authorization Alice must complete for `name` before her call can run. */
export function challenge(
  attemptId: string,
  overrides: Partial<AuthorizationChallenge> = {},
): AuthorizationChallenge {
  return {
    attemptId,
    challenge: { url: `https://idp.example/authorize/${attemptId}` },
    hookUrl: `https://agent.example/callback/${attemptId}`,
    name: "weather",
    principal: { id: "alice", issuer: "test", type: "user" },
    principalId: "alice",
    requester: ALICE,
    resume: { nonce: attemptId },
    ...overrides,
  };
}

/**
 * Alice's calls `callIds` need these authorizations before they can run; `messages`
 * is the step's response that asked.
 */
export function authorizationRequired(
  challenges: readonly AuthorizationChallenge[],
  callIds: readonly string[] = ["call-weather"],
  messages: readonly ModelMessage[] = [],
): Extract<Input, { type: "authorization.required" }> {
  return {
    at: AT,
    callIds,
    challenges,
    messages,
    requester: ALICE,
    type: "authorization.required",
  };
}

/** A turn waiting on Alice's authorizations. */
export function waitingOnAuthorizations(...challenges: AuthorizationChallenge[]): Turn {
  return Turn.idle().input(authorizationRequired(challenges));
}

/** The identity provider calls back for authorization attempt `attemptId`. */
export function callback(
  attemptId: string,
  connectionName = "weather",
): Extract<Input, { type: "authorization.completed" }> {
  return {
    attemptId,
    callback: { method: "GET", params: { code: "ok" } },
    connectionName,
    outcome: "authorized",
    type: "authorization.completed",
  };
}

/**
 * `session` parked on a model step's runtime calls, as the tool loop leaves
 * it: the step's response held out of history until their results arrive.
 */
export function parkedOnRuntimeCalls<T extends { readonly state?: SessionStateMap }>(
  session: T,
  input: {
    readonly at: RequestAt;
    readonly messages: readonly ModelMessage[];
    readonly tasks: readonly RuntimeWorkflowTaskRequest[];
  },
): T {
  const { state } = reduceHumanInput(session.state, { ...input, type: "actions.dispatched" });
  return { ...session, state };
}
