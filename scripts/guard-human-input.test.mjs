import assert from "node:assert/strict";
import test from "node:test";

import { checkHumanInputBoundary } from "./guard-human-input.mjs";

const OUTSIDE = "packages/eve/src/harness/tool-loop.ts";

/** @param {string} text @param {string} [posix] */
const lines = (text, posix = OUTSIDE) =>
  checkHumanInputBoundary(posix, text).map((violation) => violation.line);

test("flags human input changed outside harness/human-input/", () => {
  assert.deepEqual(lines("await HumanInput.commit(host, session, input);"), [1]);
  assert.deepEqual(lines("const next = Turn.idle().interrupt(signInRequired(challenges));"), [1]);
  assert.deepEqual(lines("const event = createInputRequestedEvent({ requests });"), [1]);
  assert.deepEqual(lines("emit(createAuthorizationCompletedEvent(challenge, outcome));"), [1]);
});

test("flags a turn waiting on input, built or by hand", () => {
  assert.deepEqual(
    lines(
      'emit(\n  createTurnWaitingEvent({\n    on: "input",\n    sequence,\n    turnId,\n  }),\n);',
    ),
    [2],
  );
  assert.deepEqual(lines("emit(createTurnWaitingEvent({ on, sequence, turnId }));"), [1]);
  assert.deepEqual(
    lines('emit({ type: "turn.waiting", data: { on: "input", sequence, turnId } });'),
    [1],
  );
});

test("flags a human input event built by hand", () => {
  assert.deepEqual(
    lines('await emit({\n  type: "input.requested",\n  data: { requests, sequence, turnId },\n});'),
    [2],
  );
  assert.deepEqual(
    lines('await emit({\n  data: { nested: { at }, requests },\n  type: "approval.settled",\n});'),
    [3],
  );
});

test("allows runtime waits, forwarded events, types, and intakes", () => {
  assert.deepEqual(
    lines('emit(createTurnWaitingEvent({ on: "tasks", sequence, turnId, usage }));'),
    [],
  );
  assert.deepEqual(
    lines('emit({ type: "turn.waiting", data: { on: "tasks", sequence, turnId } });'),
    [],
  );
  assert.deepEqual(lines('await forward({ data, type: "authorization.required" }, ctx);'), []);
  assert.deepEqual(lines('await forward({ data: event.data, type: "input.requested" });'), []);
  assert.deepEqual(
    lines('type Requested = Extract<MessageStreamEvent, { type: "input.requested" }>;'),
    [],
  );
  assert.deepEqual(
    lines('await commitTurn(postStep, session, { challenges, type: "authorization.required" });'),
    [],
  );
});

test("allows human input itself, the protocol, and tests", () => {
  const built = "emit(createInputRequestedEvent({ requests }));\nTurn.idle().interrupt(x);";
  assert.deepEqual(lines(built, "packages/eve/src/harness/human-input/relayed.ts"), []);
  assert.deepEqual(lines(built, "packages/eve/src/protocol/message.ts"), []);
  assert.deepEqual(lines(built, "packages/eve/src/internal/testing/human-input.ts"), []);
  assert.deepEqual(lines(built, "packages/eve/src/harness/tool-loop.test.ts"), []);
});
