---
issue: https://github.com/vercel/eve/issues/3602
status: implemented
last_updated: "2026-09-21"
---

# Lazy dynamic skill packages

Dynamic skill resolution currently acquires the sandbox before advertising
skills and rewrites every package on refresh. Loading dynamic markdown also
reads the sandbox, so an unused package adds filesystem work before inference.

## Authoring contract

Keep the existing `defineDynamic`, `defineSkill`, `load_skill`, and
`ctx.getSkill` APIs. Persist complete resolved packages in durable session
state. Listing skills and loading their markdown must not acquire a sandbox,
even when a package includes supporting files or execution resumes in a fresh
workflow step. Empty results with no prior materialization do no sandbox work.

Static and dynamic skills share one in-memory lookup with dynamic precedence.
Prepare dynamic instruction bodies during resolution, preserving the original
`SKILL.md` bytes for the sandbox. Static instruction bodies already come from
the compiled agent and need no per-session copy or load-time preprocessing.

Accessing the sandbox through `ctx.getSandbox`, a skill file handle, or a
built-in filesystem tool materializes the current package files before reading
or running commands. An unused supporting file remains unstaged until this
access boundary. Shared sandbox readers see the owner's current packages.

## Refresh and recovery

Track the names this session has staged. Unchanged resolver results need no
sandbox access. A sandbox-local receipt identifies the complete file revision
successfully written, including supporting-file bytes. Check the receipt and
declared file checksums on access so shared readers and cold resumes can reuse that
revision. A replacement sandbox materializes the current packages again. A changed
package replaces its directory so removed files and file/directory shape
changes cannot leave stale content. Other packages remain untouched.

Removing a dynamic skill immediately removes its availability and markdown.
Reconcile any staged files, restoring a same-named authored package when a
dynamic override ends. Failed materialization must remain retryable and must
not record the package as successfully staged.

Shared-child preparation must return materialization bookkeeping to the owner's
current durable context, even when it runs with a separate invocation snapshot.
The cross-deployment checkpoint version is 7 because older dynamic manifests
retain only names and descriptions. An incompatible handoff is rejected and
the original deployment keeps the session.

Retaining package bytes increases durable session state. Limit each file to
256 KiB, each package to 128 files including `SKILL.md`, and the combined
serialized manifest to 1 MiB. Account for base64 expansion and the retained
instruction body before copying bytes or changing the active manifest.

Invalidate the receipt
before replacing files and write it last. Preserve runtime-generated sibling
files until the resolver changes the package. Directory replacement retains the existing
non-atomic behavior: concurrent readers sharing a sandbox can observe an
in-progress replacement. Check declared file bytes in one sandbox command so
a mixed concurrent write is repaired on the next access instead of remaining
valid indefinitely. This change does not add filesystem transactions.

## Verification

Focused lifecycle tests count sandbox acquisitions and package writes across
empty results, markdown loading, lazy access, unchanged and changed refreshes,
removal, overrides, durable recovery, and sandbox replacement. Fixture evals
load dynamic markdown, then read supporting files through both a skill handle
and a built-in filesystem tool in later durable steps. Run fixture evals in CI.

A local comparison against `e110eb2af` used five runs per case and a mock sandbox
with a single 25 ms startup delay. Median cold resolver dispatch fell from
27.1–27.5 ms to 0.01–0.05 ms for null, markdown-only, and two-supporting-file
results. Each previously made two sandbox accessor calls; all now make zero.
The three-file package previously rewrote three files on an unchanged refresh;
the new lifecycle makes zero accessor calls and zero writes. These controlled
measurements isolate lifecycle overhead; they do not measure a live VM or model.
