#!/usr/bin/env node
// Anonymization for gap-register reports.
//
//   node redact.mjs <report.md> --map <dir>          rewrite the report in place with placeholders
//   node redact.mjs <report.md> --map <dir> --check  list anything identifying that is still present
//
// <dir>/anonymize.json:
// {
//   "org":        ["acme-corp", "Acme Corp", "acme"],
//   "agent":      ["helper"],
//   "people":     [["Jane Doe", "jdoe", "Jane", "JANE"], ["Sam Roe", "sroe"]],
//   "apps":       [["Portal", "portal"], ["Ledger", "ledger"]],
//   "hosts":      ["internal.example.com"],
//   "extra":      { "Europe/Lisbon": "<tz>" }
// }
// Every term is replaced case-sensitively as written, and also with its first letter
// upper/lower-cased. Longest terms are replaced first. The same module is used by
// check-report.mjs so excerpts can be compared to source "verbatim modulo redaction".
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const URL_ALLOW = [
  "github.com",
  "eve.dev",
  "vercel.com",
  "npmjs.com",
  "slack.com",
  "api.slack.com",
];

export function loadMap(dir) {
  const file = join(dir, "anonymize.json");
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const pairs = [];
  const add = (terms, placeholder) => {
    for (const t of terms) {
      if (!t) continue;
      const variants = new Set([
        t,
        t[0].toUpperCase() + t.slice(1),
        t[0].toLowerCase() + t.slice(1),
        t.toUpperCase(),
      ]);
      for (const v of variants) pairs.push([v, placeholder]);
    }
  };
  add(raw.org ?? [], "<org>");
  add(raw.agent ?? [], "<agent>");
  (raw.people ?? []).forEach((aliases, i) =>
    add(Array.isArray(aliases) ? aliases : [aliases], `<person-${i + 1}>`),
  );
  (raw.apps ?? []).forEach((aliases, i) =>
    add(Array.isArray(aliases) ? aliases : [aliases], `<app-${i + 1}>`),
  );
  add(raw.hosts ?? [], "<host>");
  for (const [k, v] of Object.entries(raw.extra ?? {})) pairs.push([k, v]);
  pairs.sort((a, b) => b[0].length - a[0].length);
  return { pairs, raw };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const boundary = (term) => {
  const start = /^[A-Za-z0-9_]/.test(term) ? "(?<![A-Za-z0-9])" : "";
  const end = /[A-Za-z0-9_]$/.test(term) ? "(?![A-Za-z0-9])" : "";
  return new RegExp(`${start}${esc(term)}${end}`, "g");
};

// Built-in detectors that need no map. Order matters: specific before generic.
const BUILTIN = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "<email>"],
  [/\b[UWTCDG](?=[A-Z0-9]*\d)[A-Z0-9]{8,10}\b/g, "<slack-id>"], // U0481BABMGA, T5BNJ6TLG, C…
  [/\b(?=[a-f0-9]*\d)[a-f0-9]{32,}\b/g, "<hex>"],
  [/\b(?:sk|xox[bap]|ghp|gho|github_pat)_[A-Za-z0-9_-]{12,}\b/g, "<token>"],
  [
    /https?:\/\/[^\s"'`)>\]]+/g,
    (m) => {
      try {
        const h = new URL(m).hostname;
        if (URL_ALLOW.some((a) => h === a || h.endsWith("." + a))) return m;
      } catch {}
      return "<url>";
    },
  ],
];

export function redact(text, map) {
  let out = text;
  for (const [term, placeholder] of map?.pairs ?? [])
    out = out.replace(boundary(term), placeholder);
  for (const [re, rep] of BUILTIN) out = out.replace(re, rep);
  return out;
}

// Reverse the mapping inside file paths so the checker can locate files named after the
// org/app. `paths` in anonymize.json states which alias appears in filenames, e.g.
// { "<org>": "acme", "<app-2>": "ledger" }. Without it, the shortest lowercase alias is used.
export function unredactPath(path, map) {
  if (!map) return path;
  let p = path;
  const explicit = map.raw.paths ?? {};
  const byPlaceholder = new Map(Object.entries(explicit));
  for (const [term, ph] of map.pairs) {
    if (byPlaceholder.has(ph)) continue;
    if (term !== term.toLowerCase()) continue;
    const cur = byPlaceholder.get(ph);
    if (!cur || term.length < cur.length) byPlaceholder.set(ph, term);
  }
  for (const [ph, term] of byPlaceholder) p = p.split(ph).join(term);
  return p;
}

export function findLeaks(text, map) {
  const leaks = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const [term] of map?.pairs ?? [])
      if (boundary(term).test(line)) leaks.push({ line: i + 1, what: term });
    for (const [re] of BUILTIN) {
      const m = line.match(re);
      if (!m) continue;
      for (const hit of m) {
        if (re.source.startsWith("https?")) {
          try {
            const h = new URL(hit).hostname;
            if (URL_ALLOW.some((a) => h === a || h.endsWith("." + a))) continue;
          } catch {}
        }
        leaks.push({ line: i + 1, what: hit });
      }
    }
  });
  return leaks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const report = args.find((a) => !a.startsWith("--"));
  const mapDir = args.includes("--map") ? args[args.indexOf("--map") + 1] : ".eve-friction";
  const map = loadMap(mapDir);
  if (!report) {
    console.error("usage: redact.mjs <report.md> --map <dir> [--check]");
    process.exit(2);
  }
  if (!map) {
    console.error(`no anonymize.json in ${mapDir}`);
    process.exit(2);
  }
  const text = readFileSync(report, "utf8");
  if (args.includes("--check")) {
    const leaks = findLeaks(text, map);
    if (leaks.length) {
      for (const l of leaks) console.error(`line ${l.line}: ${l.what}`);
      process.exit(1);
    }
    console.log("redact: no leaks");
  } else {
    const out = redact(text, map);
    writeFileSync(report, out);
    const leaks = findLeaks(out, map);
    console.log(`redact: rewrote ${report}; ${leaks.length} residual leak(s)`);
    for (const l of leaks) console.error(`line ${l.line}: ${l.what}`);
    process.exit(leaks.length ? 1 : 0);
  }
}
