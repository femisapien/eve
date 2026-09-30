#!/usr/bin/env node
// Verifies a gap-register report: anonymization, structure, counts, index anchors, and that
// every code excerpt is verbatim (modulo redaction) against the project checkout.
// Usage: check-report.mjs <report.md> <project-root> [--map <dir>]   (default map dir: .eve-friction)
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadMap, redact, unredactPath, findLeaks } from "./redact.mjs";

const args = process.argv.slice(2);
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--map");
const [reportPath, root] = positional;
if (!reportPath || !root) {
  console.error("usage: check-report.mjs <report.md> <project-root> [--map <dir>]");
  process.exit(2);
}
const mapDir = args.includes("--map") ? args[args.indexOf("--map") + 1] : ".eve-friction";
const map = loadMap(mapDir, root);
const text = readFileSync(reportPath, "utf8");
const lines = text.split("\n");
const problems = [];
const fail = (msg) => problems.push(msg);

// Anonymization: no mapped term, identifier class, or project commit SHA anywhere.
if (!map)
  fail(
    `no anonymize.json found in ${mapDir}; create it (SKILL.md step 1) so the leak check can run`,
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

const countMatch = text.match(/^(\d+) gaps?\./m);
if (!countMatch) fail("opening lines do not state '<n> gaps.'");
else if (Number(countMatch[1]) !== blocks.length)
  fail(`opening says ${countMatch[1]} gaps, found ${blocks.length} blocks`);

// Required sections; header regexes tolerate formatter padding.
const header = (cells) =>
  new RegExp(
    "^\\|\\s*" + cells.map((c) => c.replace(/[()]/g, "\\$&")).join("\\s*\\|\\s*") + "\\s*\\|\\s*$",
    "m",
  );
if (!/^## Index\s*$/m.test(text)) fail("missing '## Index' section");
else if (!header(["ID", "Gap", "Workaround (lines)", "Tracked"]).test(text))
  fail("index is missing its header row (ID | Gap | Workaround (lines) | Tracked)");
if (!/^## Tool shape\s*$/m.test(text)) fail("missing '## Tool shape' section");
else if (!header(["Family", "Members", "Lines", "With approval", ".*"]).test(text))
  fail("Tool shape section is missing its family table");

// Index rows and anchors
const slug = (h) =>
  h
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
const indexRows = [...text.matchAll(/^\|\s*\[(A\d+)\]\(#([^)]+)\)/gm)].map((m) => ({
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

// Per-block structure and language
const labels = [
  "**Gap.**",
  "**What eve says.**",
  "**What the project built.**",
  "**How it fails.**",
];
const stripFences = (s) => s.replace(/```[\s\S]*?```/g, "");
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
  const prose = stripFences(joined);
  const verdict = prose.match(
    /\b(should|propose[sd]?|proposed shape|accepts when|acceptance criteria|recommend(?:ed|s)?|priority:|P[0-3])\b/i,
  );
  if (verdict) fail(`${b.id}: contains proposal/verdict language: "${verdict[0]}"`);
}

// Excerpts, everywhere in the report: a heading line `path:a-b[, c-d]` within 3 lines above a fence.
const headRe = /^`([^`]+?):(\d+(?:-\d+)?(?:, ?\d+(?:-\d+)?)*)`/;
const norm = (s) => s.replace(/\s+/g, " ").trim();
const expandBraces = (p) => {
  const m = p.match(/^(.*)\{([^}]+)\}(.*)$/);
  return m ? m[2].split(",").map((alt) => m[1] + alt.trim() + m[3]) : [p];
};
function parseRanges(ranges) {
  const out = [];
  for (const r of ranges.split(",").map((s) => s.trim())) {
    const [a, b] = r.split("-").map(Number);
    const end = b ?? a;
    if (!(a >= 1) || end < a) return null;
    out.push([a, end]);
  }
  return out;
}
function checkOneFile(where, rawPath, path, ranges, excerpt) {
  const abs = resolve(join(root, path));
  if (!existsSync(abs)) return fail(`${where}: excerpt file not found: ${rawPath} → ${path}`);
  const file = redact(readFileSync(abs, "utf8"), map).split("\n");
  const wanted = [];
  for (const [a, end] of ranges) {
    if (end > file.length)
      return fail(`${where}: ${rawPath}:${a}-${end} out of range (file has ${file.length} lines)`);
    for (let i = a; i <= end; i++) wanted.push({ n: i, t: norm(file[i - 1]) });
  }
  let cursor = 0;
  let compared = 0;
  for (const raw of excerpt) {
    const t = norm(raw);
    if (t === "") continue;
    if (t === "…")
      return fail(
        `${where}: standalone "…" line; elide only inside a single line and cite each range instead`,
      );
    const parts = t
      .split("…")
      .map((p) => p.trim())
      .filter(Boolean);
    const matches = (fl) => (t.includes("…") ? parts.every((p) => fl.includes(p)) : fl === t);
    while (cursor < wanted.length && wanted[cursor].t === "") cursor++;
    if (!(cursor < wanted.length && matches(wanted[cursor].t))) {
      const at = wanted[cursor] ? `${rawPath}:${wanted[cursor].n}` : `${rawPath} (past range)`;
      return fail(
        `${where}: excerpt line does not match ${at}\n    excerpt: ${raw.trim().slice(0, 120)}\n    file:    ${(wanted[cursor]?.t ?? "").slice(0, 120)}`,
      );
    }
    cursor++;
    compared++;
  }
  if (compared === 0) fail(`${where}: empty excerpt for ${rawPath}`);
}
function whereOf(lineNo) {
  const b = blocks.find((x) => lineNo >= x.start && lineNo < x.end);
  return b ? b.id : `line ${lineNo + 1}`;
}
for (let i = 0; i < lines.length; i++) {
  if (!lines[i].startsWith("```")) continue;
  const close = lines.findIndex((l, j) => j > i && l.startsWith("```"));
  if (close < 0) {
    fail(`unclosed fence at line ${i + 1}`);
    break;
  }
  let head = null;
  for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
    const m = lines[k].match(headRe);
    if (m) {
      head = m;
      break;
    }
  }
  const where = whereOf(i);
  const inBlock = blocks.some((x) => i >= x.start && i < x.end);
  if (!head) {
    if (inBlock || /^## Tool shape/m.test(lines.slice(0, i).join("\n")))
      fail(
        `${where}: fence at line ${i + 1} has no \`path:start-end\` heading within 3 lines above`,
      );
  } else {
    const ranges = parseRanges(head[2]);
    if (!ranges) fail(`${where}: bad range "${head[2]}" for ${head[1]}`);
    else
      for (const p of expandBraces(head[1]))
        checkOneFile(where, head[1], unredactPath(p, map), ranges, lines.slice(i + 1, close));
  }
  i = close;
}

if (problems.length) {
  console.error(`check-report: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error("- " + p);
  process.exit(1);
}
console.log(
  `check-report: OK — ${blocks.length} gaps, ${indexRows.length} index rows, all excerpts verbatim (modulo redaction), no leaks`,
);
