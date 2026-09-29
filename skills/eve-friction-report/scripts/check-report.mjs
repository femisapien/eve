#!/usr/bin/env node
// Verifies a gap-register report: structure, counts, index anchors, and that every
// code excerpt is verbatim against the project checkout.
// Usage: node check-report.mjs <report.md> <project-root>
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadMap, redact, unredactPath, findLeaks } from "./redact.mjs";

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--map");
const [reportPath, root] = positional;
if (!reportPath || !root) {
  console.error(
    "usage: check-report.mjs <report.md> <project-root> [--map <dir>]   (default map dir: .eve-friction)",
  );
  process.exit(2);
}
const mapDir = args.includes("--map") ? args[args.indexOf("--map") + 1] : ".eve-friction";
const map = loadMap(mapDir);
const text = readFileSync(reportPath, "utf8");
const lines = text.split("\n");
const problems = [];
const fail = (msg) => problems.push(msg);

// Anonymization: the report must contain no mapped term and no built-in identifier class.
if (!map)
  fail(
    `no anonymize.json found in ${mapDir}; create it (see SKILL.md step 1) so the leak check can run`,
  );
for (const leak of findLeaks(text, map)) fail(`leak at line ${leak.line}: ${leak.what}`);

// Blocks: "## A<n>. <title>"
const blockRe = /^## (A\d+)\. (.+)$/;
const blocks = [];
lines.forEach((l, i) => {
  const m = l.match(blockRe);
  if (m) blocks.push({ id: m[1], title: m[2], start: i });
});
blocks.forEach((b, i) => (b.end = i + 1 < blocks.length ? blocks[i + 1].start : lines.length));
if (blocks.length === 0) fail("no gap blocks (## A<n>. ...) found");

// Opening count: "<n> gaps."
const countMatch = text.match(/^(\d+) gaps?\./m);
if (!countMatch) fail("opening lines do not state '<n> gaps.'");
else if (Number(countMatch[1]) !== blocks.length)
  fail(`opening says ${countMatch[1]} gaps, found ${blocks.length} blocks`);

// Index rows: "| [A<n>](#anchor) |"
const slug = (h) =>
  h
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
if (!/^## Index\s*\n\s*\n?\| ID \| Gap \| Workaround \(lines\) \| Tracked \|\s*\n\|---/m.test(text))
  fail(
    "index is missing its header row (| ID | Gap | Workaround (lines) | Tracked |) and separator",
  );
if (!/^## Tool shape\s*$/m.test(text)) fail("missing '## Tool shape' section");
else if (!/^\| Family \| Members \| Lines \| With approval \|/m.test(text))
  fail("Tool shape section is missing its family table");
const indexRows = [...text.matchAll(/^\| \[(A\d+)\]\(#([^)]+)\)/gm)].map((m) => ({
  id: m[1],
  anchor: m[2],
}));
if (indexRows.length !== blocks.length)
  fail(`index has ${indexRows.length} rows, found ${blocks.length} blocks`);
for (const row of indexRows) {
  const b = blocks.find((x) => x.id === row.id);
  if (!b) {
    fail(`index row ${row.id} has no block`);
    continue;
  }
  const expected = slug(`${b.id}. ${b.title}`);
  if (row.anchor !== expected)
    fail(`index anchor for ${row.id} is #${row.anchor}, heading slug is #${expected}`);
}

// Per-block structure
const labels = [
  "**Gap.**",
  "**What eve says.**",
  "**What the project built.**",
  "**How it fails.**",
];
for (const b of blocks) {
  const body = lines.slice(b.start, b.end);
  const joined = body.join("\n");
  for (const label of labels) {
    const n = body.filter((l) => l.startsWith(label)).length;
    if (n !== 1) fail(`${b.id}: expected exactly one paragraph starting with ${label}, found ${n}`);
  }
  const order = labels.map((l) => body.findIndex((x) => x.startsWith(l)));
  if (order.every((i) => i >= 0) && !order.every((v, i, a) => i === 0 || a[i - 1] < v))
    fail(`${b.id}: paragraphs out of order`);
  if (!/^```/m.test(joined)) fail(`${b.id}: no code excerpt`);
  if (!/\[V\]/.test(joined)) fail(`${b.id}: no [V] tag`);
  const prose = joined.replace(/```[\s\S]*?```/g, "");
  const verdict = prose.match(
    /\b(eve should|we propose|proposed shape|accepts when|acceptance criteria|priority:|\bP[0-3]\b(?! [a-z]))/i,
  );
  if (verdict) fail(`${b.id}: contains proposal/verdict language: "${verdict[0]}"`);
}

// Excerpts: a heading line `path:a-b[, c-d]` (optionally followed by text) within 2 lines before a fence.
const headRe = /^`([^`]+?):(\d+(?:-\d+)?(?:, ?\d+(?:-\d+)?)*)`/;
const expandBraces = (p) => {
  const m = p.match(/^(.*)\{([^}]+)\}(.*)$/);
  return m ? m[1] + m[2].split(",")[0].trim() + m[3] : p;
};
const norm = (s) => s.replace(/\s+/g, " ").trim();
function checkExcerpt(blockId, head, excerpt, fenceLine) {
  const [, rawPath, ranges] = head;
  const path = unredactPath(expandBraces(rawPath), map);
  const abs = resolve(join(root, path));
  if (!existsSync(abs)) {
    fail(
      `${blockId}: excerpt file not found: ${rawPath} → ${path} (fence at line ${fenceLine + 1})`,
    );
    return;
  }
  // Compare against the redacted source so excerpts are verbatim modulo anonymization.
  const file = redact(readFileSync(abs, "utf8"), map).split("\n");
  const wanted = [];
  for (const r of ranges.split(",").map((s) => s.trim())) {
    const [a, b] = r.split("-").map(Number);
    const end = b ?? a;
    if (a < 1 || end > file.length) {
      fail(`${blockId}: ${path}:${r} out of range (file has ${file.length} lines)`);
      return;
    }
    for (let i = a; i <= end; i++) wanted.push({ n: i, t: norm(file[i - 1]) });
  }
  let cursor = 0;
  let skipping = false;
  for (const raw of excerpt) {
    const t = norm(raw);
    if (t === "") continue;
    if (t === "…") {
      skipping = true;
      continue;
    }
    const parts = t
      .split("…")
      .map((p) => p.trim())
      .filter(Boolean);
    const matches = (fl) =>
      parts.length > 1 || t.includes("…") ? parts.every((p) => fl.includes(p)) : fl === t;
    let found = -1;
    if (skipping) {
      for (let i = cursor; i < wanted.length; i++)
        if (matches(wanted[i].t)) {
          found = i;
          break;
        }
    } else {
      while (cursor < wanted.length && wanted[cursor].t === "") cursor++;
      if (cursor < wanted.length && matches(wanted[cursor].t)) found = cursor;
    }
    if (found < 0) {
      const at = wanted[cursor] ? `${path}:${wanted[cursor].n}` : `${path} (past range)`;
      fail(
        `${blockId}: excerpt line does not match ${at}\n    excerpt: ${raw.trim().slice(0, 120)}\n    file:    ${(wanted[cursor]?.t ?? "").slice(0, 120)}`,
      );
      return;
    }
    cursor = found + 1;
    skipping = false;
  }
}
for (const b of blocks) {
  for (let i = b.start; i < b.end; i++) {
    if (!lines[i].startsWith("```")) continue;
    const close = lines.findIndex((l, j) => j > i && l.startsWith("```"));
    if (close < 0) {
      fail(`${b.id}: unclosed fence at line ${i + 1}`);
      break;
    }
    let head = null;
    for (let k = i - 1; k >= Math.max(b.start, i - 3); k--) {
      const m = lines[k].match(headRe);
      if (m) {
        head = m;
        break;
      }
    }
    if (!head)
      fail(
        `${b.id}: fence at line ${i + 1} has no \`path:start-end\` heading within 3 lines above`,
      );
    else checkExcerpt(b.id, head, lines.slice(i + 1, close), i);
    i = close;
  }
}

// Evidence tags outside blocks are fine; inside, [I]/[R] must exist only in prose.
if (problems.length) {
  console.error(`check-report: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error("- " + p);
  process.exit(1);
}
console.log(
  `check-report: OK — ${blocks.length} gaps, ${indexRows.length} index rows, all excerpts verbatim (modulo redaction), no leaks`,
);
