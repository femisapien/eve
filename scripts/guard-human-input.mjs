/**
 * Rule 51 of `guard-invariants.mjs`: only human input
 * (`harness/human-input/`) changes human input. Kept apart so its cases are
 * tested in `guard-human-input.test.mjs`.
 */

const HUMAN_INPUT_DIR = "packages/eve/src/harness/human-input/";
const EXEMPT_DIRS = ["packages/eve/src/protocol/", "packages/eve/src/internal/testing/"];
const TEST_FILE_RE = /\.(?:test|integration\.test|scenario\.test)\.ts$/;

const EVENT_BUILDER_RE =
  /\bcreate(?:Input(?:Requested|Resolved)|Authorization(?:Required|Completed)|Approval(?:Candidate|Settled))Event\b/g;
// A turn's interrupt and intake, and the session commit they feed.
const COMMIT_RE = /\bHumanInput\.commit\b|\bTurn\b[^;\n]*?\.(?:interrupt|intake)\(/g;
const WAITING_BUILDER_RE = /\bcreateTurnWaitingEvent\s*\(/g;
const EVENT_TYPE_RE =
  /\btype:\s*["'](input\.(?:requested|resolved)|authorization\.(?:required|completed)|approval\.(?:candidate|settled)|turn\.waiting)["']/g;

/**
 * @typedef {{ readonly line: number; readonly message: string }} HumanInputViolation
 * @param {string} posix repo-relative path
 * @param {string} text file contents
 * @returns {HumanInputViolation[]}
 */
export function checkHumanInputBoundary(posix, text) {
  if (
    !posix.startsWith("packages/eve/src/") ||
    posix.startsWith(HUMAN_INPUT_DIR) ||
    EXEMPT_DIRS.some((dir) => posix.startsWith(dir)) ||
    TEST_FILE_RE.test(posix) ||
    posix.includes("/test/")
  ) {
    return [];
  }
  /** @type {HumanInputViolation[]} */
  const violations = [];
  /** @param {number} index @param {string} message */
  const report = (index, message) =>
    violations.push({ line: text.slice(0, index).split("\n").length, message });

  for (const match of text.matchAll(EVENT_BUILDER_RE)) {
    report(
      match.index,
      `uses ${match[0]} outside harness/human-input/. Only human input builds the events a request, approval, or sign-in reports: commit the change through harness/human-input/effects/ and publish what it returns.`,
    );
  }
  for (const match of text.matchAll(COMMIT_RE)) {
    report(
      match.index,
      `calls ${match[0].includes("commit") ? "HumanInput.commit" : "a turn's interrupt or intake"} outside harness/human-input/. Change human input only through the effects entry points (commitTurn, commitSessionStep), so one place commits it and reports its events.`,
    );
  }
  for (const match of text.matchAll(WAITING_BUILDER_RE)) {
    const args = balanced(text, match.index + match[0].length - 1, "(", ")");
    if (/\bon:\s*["']tasks["']/.test(args)) continue;
    report(
      match.index,
      'builds a turn.waiting event that is not a runtime wait (on: "tasks") outside harness/human-input/. A turn waits on input only when human input holds it; commit the hold and publish what it returns.',
    );
  }
  for (const match of text.matchAll(EVENT_TYPE_RE)) {
    const start = enclosingBrace(text, match.index);
    if (start === undefined) continue;
    const object = balanced(text, start, "{", "}");
    // A type, such as `Extract<…, { type: "input.requested" }>`, or an event
    // forwarded with the data it came with, builds nothing.
    const data = /\bdata:\s*\{/.exec(object);
    if (data === null) continue;
    if (match[1] === "turn.waiting" && /\bon:\s*["']tasks["']/.test(object)) continue;
    report(
      match.index,
      `builds a ${match[1]} event by hand outside harness/human-input/. Only human input builds the events a request, approval, sign-in, or input wait reports; forward an existing event's data, or commit through harness/human-input/effects/.`,
    );
  }
  return violations.sort((a, b) => a.line - b.line);
}

/** The text from `open` at `start` to its matching `close`. */
function balanced(text, start, open, close) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === open) depth++;
    else if (text[index] === close && --depth === 0) return text.slice(start, index + 1);
  }
  return text.slice(start);
}

/** The index of the `{` that opens the object literal around `index`. */
function enclosingBrace(text, index) {
  let depth = 0;
  for (let at = index - 1; at >= 0; at--) {
    if (text[at] === "}") depth++;
    else if (text[at] === "{" && depth-- === 0) return at;
  }
  return undefined;
}
