---
issue: "TBD (maintainer-requested research; no issue linked)"
status: proposed
last_updated: "2026-09-28"
---

# Per-mount extension configuration and state

## Problem

An extension is reusable source, but its configuration belongs to an instance
mounted by an agent. Today eve identifies configuration by the extension's
package name. `defineExtension()` binds values into a process-global registry;
extension code reads the entry for that package. Mounting the same package in
two places therefore allows one mount to overwrite another's configuration.
Separate local subagent nodes do not isolate this registry.

Different extensions distributed inside the `eve` package also collide because
their package identity is the same. Package metadata still locates extension
source but no longer owns configuration or state identity.

State has a related, but different, boundary. `defineState()` creates a named
slot in the active durable context, not a process-global value. The bundler
prefixes extension state names with the package namespace. Two mounts executing
in the same context can therefore share a state slot unintentionally. Identical
keys in separate session contexts do not, by themselves, imply shared values.
Per-mount keys must preserve these existing session/context boundaries.

## Illustrative failure and intended behavior

Suppose a hypothetical `@acme/browser` extension accepts an account and a request
budget. Its tools import its `defineExtension()` handle to read configuration and
use `defineState("requests", () => 0)` for usage accounting.

```ts
// agent/subagents/research/extensions/browser.ts
import browser from "@acme/browser";
export default browser({ account: "research", requestLimit: 20 });
```

```ts
// agent/subagents/support/extensions/browser.ts
import browser from "@acme/browser";
export default browser({ account: "support", requestLimit: 5 });
```

Today both mount calls bind the `acme-browser` configuration entry. Whichever
binds last wins: research can read support's account and limit. This is an
ownership bug, not an intended configuration override. Separate tool names or
subagent registries do not fix it.

A same-node example also exposes state aliasing: mounting the package as both
`agent/extensions/research.ts` and `agent/extensions/support.ts` gives distinct
contribution names, but both `requests` handles address `acme-browser.requests`
in that node's active context. Updating one can change the other's count.

After this change each mount reads its own configuration, and its state handle
addresses its own slot in the current context. Authors keep the same
`defineExtension({ config })`, `extension.config`, and `defineState(name, initial)`
APIs; consumers keep the same mount files. No namespace argument is required.
Registry installation (`eve add`, or the self-modification `registry_add` tool)
continues to write the item's declared mount file. It does not supply another
instance-identity mechanism.

## Proposed identity and semantics

Use a canonical logical mount path relative to the root agent tree:

```text
extensions/browser
subagents/research/extensions/browser
subagents/support/extensions/browser
```

Derive this from the owning node's stable logical path and the mount name. Do not
use an absolute source path, package version, generated bundle hash, deployment
id, or transient runtime invocation id. Normalize `extensions/browser.ts` and
`extensions/browser/extension.ts` to the same identity. Adding directory overrides
must not create a new instance.

- Contribution names keep the existing mount prefix, such as `browser__search`.
- Config belongs to `(loaded application graph, logical mount identity)`.
  Concurrent applications and old/new dev generations must not overwrite each
  other's bindings, even when their logical paths match.
- State belongs to the active durable context, logical mount identity, and authored
  state name. Encode the latter two components unambiguously in a versioned key
  format under a new reserved `eve-mount.` prefix. Public `defineState()` calls
  must reject authored names starting with `eve-mount.`, as they already reject
  `eve.`. Only a trusted internal registration path may create generated mount
  keys. The encoding after the reserved prefix is internal.
- A package upgrade at the same mount preserves identity, but does not promise
  compatibility with arbitrary changes to the authored state's value schema.
- Renaming or moving a logical mount changes identity. It does not automatically
  transfer the former instance's state.
- Subagents contributed by an extension inherit that extension's mount identity
  when reading its config or defining its state. They still execute within their
  own runtime contexts. An independently authored subagent mounting the same
  package creates a different instance.
- Repeated calls to a mounted subagent do not create new configuration instances.
  This proposal changes mount ownership, not subagent session lifetime.
- Application-owned `defineState()` keys are unchanged except that names under
  `eve-mount.` become invalid. Existing uses require an explicit state migration
  or session restart; they must never be interpreted as extension state. Shared
  state between mounts is not implicit; an explicit sharing API is outside this
  proposal.

## Architecture

A different registry key alone is insufficient. Production currently selects a
scope by matching an importer's physical source directory. Two mounts of the
same package match the same directory and can share the same evaluated module
and extension handle.

```text
logical mount + owning node
          │
          ▼
compiler mount-instance descriptor
          │
          ├── mount-specific extension module graph ──► instance-bound config
          │              │
          │              └── defineState shim ──► stable mount-prefixed key
          │
          └── runtime metadata ──► checkpoint compatibility / legacy-key import
```

### Compiler and module loading

Load extension code separately for each mount, with its configuration ready before
its tools and other contributions initialize. This costs extra loading work when
an extension is mounted twice, but prevents the mounts from sharing configuration
accidentally. Framework code and ordinary dependencies remain shared.

Track which mount owns each contribution, including subagents and consumer
overrides. If an import could refer to several mounts, report an error rather than
guess. New syntax for choosing a mount is outside this proposal.

Apply the same rules in production, development, and evals, including mounts
created programmatically. Hot reloads and separate applications must not reuse
each other's extension instances.

### Configuration and state ownership

Configuration belongs to a mount in the running application; durable state belongs
to that mount within the current session/context. On deployment handoff, use the
new deployment's configuration rather than saving callbacks or credentials in
checkpoints. State keys stay stable across rebuilds so saved values can survive.

Keep state naming and migration in the framework, without adding namespace
arguments to the authoring API. Only framework code may create reserved mount
keys. This makes isolation automatic, but introduces a compatibility boundary:
old application state using the newly reserved prefix must be explicitly migrated
or the session restarted, even if the application has removed the declaration.
Reject those collisions before restoring state; never silently discard values or
treat them as extension state.

## Implementation steps

1. **Define and propagate mount identity (metadata only).** Specify canonical path
   encoding, flat/directory equivalence, contributed-subagent inheritance, and
   compiled metadata. Preserve the existing package-scoped config binding and
   state-key shims until their replacements are active in steps 3 and 4.
2. **Instantiate extension module graphs per mount.** Update production resolution,
   dev/eval resolution, cache identity, and programmatic development mounts. Resolve
   override imports in their mount context and reject ambiguous unowned imports.
3. **Bind config to the loaded graph and mount.** Ensure mount-before-contribution
   evaluation, config validation, independent hot-reload generations, and no
   process-global package binding or native-module-cache leakage. Retire the legacy
   config scope only when these bindings are active; retain package-prefixed state.
4. **Scope state handles and implement upgrade admission.** Introduce reserved,
   mount-owned state keys and the trusted internal registration path. Choose one
   compatibility policy below and activate checkpoint admission before switching
   state shims or retiring package-prefixed registration. Remove obsolete
   package/subpath scope ownership only after both replacements are active; never
   ship an intermediate release that leaves config unbound or discards old values.
5. **Validate the contract at its boundaries.** Cover identity normalization in
   unit tests; two configured mounts, two authored subagents, and inherited
   contributed-subagent config in module-loading scenarios; and independent state
   updates across serialization/restoration. Exercise both production and dev/eval,
   including two application graphs/generations in one process. Add deterministic
   fixture eval coverage for mounted contributions. Upgrade scenarios must use
   independently produced old/new artifacts and checkpoints, including ambiguous
   legacy ownership and rollback, not just a mocked compatibility flag. Add an
   integration case proving an application cannot define a generated mount key to
   read or mutate that mount's state. Cover rejection of pre-upgrade authored names
   under `eve-mount.` in upgrade scenarios, including when the new application has
   removed the declaration, without losing or reinterpreting the saved value.
6. **Publish and remove the bridge on schedule.** Document rename semantics,
   preserved application-owned state outside the newly reserved prefix, rebuild
   requirements, and operator upgrade steps. Add release notes/changesets
   appropriate to the chosen compatibility contract. If using a bridge release,
   gate its removal at the major release on the conditions below, not merely
   elapsed time.

## Backward compatibility and rollout options

### What actually happens during an upgrade

Installing a new eve package does not rewrite a running deployment. New sessions
start with the new code; old workflows can continue on their original deployment
while it remains available. The hazardous boundary is loading old saved state
with new code, including an idle session's cross-deployment handoff and local
restore after a rebuild.

Currently `deserializeContext()` loads the bundle, resolves registered keys by
name, and drops unknown keys with a warning. Changing a prefix without an upgrade
policy can discard an old extension value and cause `initial()` to run under the
new key. This is a possible silent reset, not a guaranteed immediate exception.
Application-authored state whose keys do not change is not inherently affected.

### Option A: hard compatibility boundary

Ship new mount keys with an incompatible checkpoint contract. For a deployment
upgrade from A to B:

1. A receives an eligible request accepted on B and attempts an idle-session handoff.
2. B rejects A's incompatible checkpoint before activating or doing tool/model work.
3. A recovers ownership and handles the request using its original code and keys.
4. New sessions start on B. Existing sessions finish on A or are explicitly restarted.

The existing `SessionHandoff` and checkpoint-version validation provide this
pattern. A checkpoint-version bump is coarse: it can block unaffected sessions
too. Local restores and other state-loading paths must also reject incompatible
state; a handoff-only check is not sufficient.

This is "safer" only in the sense that it refuses a state reinterpretation rather
than resetting data. It does **not** migrate the session, make old code disappear,
or guarantee successful recovery if deployment A has been deleted. Operators must
retain A for the required workflow lifetime. Busy sessions may stay there for a
long time, and old sessions do not receive B's fixes until restarted or migrated.

### Option B: temporary package-key fallback, then remove it at the major release

Recommended if existing sessions should upgrade without a blanket restart.
The fallback is a **one-way import of legacy state**, not continued package-owned
state and never a configuration fallback. All mounts get isolated config immediately.

For example, an old checkpoint contains:

```text
acme-browser.requests = 4
```

Assume trusted metadata from the source deployment proves that this saved slot
belonged only to `extensions/browser` in the checkpoint's owning node/context,
and that the target graph preserves that ownership. Only with that evidence may
checkpoint restoration import the value into the mount-owned key:

```text
eve-mount.v1[extensions/browser, requests] = 4   # illustrative encoding
```

A single browser mount in the target graph is not sufficient evidence. Hosted
checkpoints currently store a generic bundled-artifact selector and node ID in
`eve.bundle`, not the predecessor's mount mapping. If no trusted source-side
ownership metadata is available, refuse automatic migration or require an explicit
migration decision; do not infer the old layout by loading the target bundle.

Subsequent updates and checkpoints use only the new key. Another mount must not
read or update the old shared slot.

The bridge needs these rules:

1. Resolve the target bundle and the checkpoint's owning node/context before
   interpreting legacy keys. Establish a package-key-to-mount mapping from
   trusted source-side ownership metadata and verify it against the target graph.
   Old artifacts may lack enough metadata; do not infer unique ownership merely
   because the new graph happens to have one mount.
2. If a key is proven to be in the new mount layout, it is authoritative, including
   values such as `0`, `false`, or `null`. An old alias must never overwrite it or
   resurrect a reset value. A legacy authored name matching the new prefix is a
   collision to reject, not proof of a migrated value.
3. Import legacy values only when ownership is unambiguous. Two candidate mounts,
   changed ownership, or an unknown source layout require an explicit migration
   decision or rejection of handoff. Do not pick the first mount or copy a shared
   budget/watch registry into every new instance. Separate subagent contexts may
   disambiguate ownership; the package name alone cannot.
4. Transform the raw serialized record **before** unknown-key dropping. A
   `defineState().get()` implementation that merely tries the old key is too late
   if deserialization already discarded it. Import all attributable saved slots,
   not only those read on the next turn, so inactive state is not lost. If ownership
   or registration cannot be established, refuse migration instead of dropping it.
5. Remove imported aliases from the candidate checkpoint and persist the new
   state-layout version with the normal durable commit. Keep the original source
   checkpoint untouched until successor activation succeeds. Replays of the import
   must produce the same result. Diagnostics identify keys/mounts, never values or
   configuration secrets.

This is a deliberately time-bounded exception to eve's preference against legacy
fallback logic. It adds compatibility metadata and a context-restoration adapter,
not a second permanent config/state model.

**Bridge release:** write a new checkpoint compatibility version and explicitly
admit the supported prior version through the migration adapter. Existing readers
that require an exact version then reject the new checkpoint on reverse handoff;
simply adding an optional state-layout field that old readers ignore is not enough.
New sessions write mount keys; old sessions can import proven legacy ownership on handoff. Ambiguous sessions remain on their source deployment
or require an explicit restart/migration. Surface migration success/refusal so an
operator can determine whether legacy sessions remain.

**Upcoming major release:** remove the legacy-key reader and accept mount-layout
checkpoints, including those already converted by the bridge. Reject legacy-only
checkpoints explicitly. Publish a supported bridge-upgrade path or require a new
session for users skipping it. Dormant sessions do not migrate merely because a
bridge was deployed: they must resume and commit converted state, finish, or be
explicitly migrated/restarted before the bridge is retired.

**Rollback:** a checkpoint written with mount keys cannot safely return to a
pre-bridge deployment that understands only package keys. Prefer a rollback build
that retains the new state-layout reader; otherwise reject reverse handoff and
retain its current owner. Do not dual-write the old package key: two isolated
mounts cannot faithfully encode independent values into one old slot. Version
admission must protect both directions before advertising rollback as supported.

### Option C: defer the state change to the major release

Ship per-mount module/config isolation first while retaining legacy state prefixes,
then change state keys at the major release using option A or B. This reduces the
immediate state-migration surface, but leaves duplicate mounts sharing state keys
within a context. Either reject affected duplicate stateful mounts or document the
limitation; do not advertise complete mount isolation. This is a staging option,
not the desired final architecture.

### Decision and release gates

Prefer option B if a bridge release can precede the major bump and its ownership
mapping can be proven. Otherwise prefer option A at the major boundary over an
unsafe heuristic migration. The implementation plan must settle:

- Which released checkpoint/artifact versions supply enough mount ownership data?
- How are legacy extension slots recognized without reinterpreting application keys?
- How do unknown or dynamically named saved slots survive migration or cause refusal?
- What old-deployment retention and reverse-handoff guarantees hold in each supported
  world, including local development?
- Will the major release require passing through the bridge, or provide a separate
  explicit migration path for dormant/legacy sessions?

A major version is an appropriate place to remove the fallback, but it is not a
mechanism for migrating data. Removal is safe when remaining legacy checkpoints
are rejected with an actionable recovery path, not silently reinitialized.

## Current implementation references

- [`defineExtension`](../packages/eve/src/public/definitions/extension.ts):
  process-global configuration registry and ambient loader scope.
- [Scope shims](../packages/eve/src/internal/bundler/extension-scope-plugin.ts),
  [compiled mount scopes](../packages/eve/src/compiler/normalize-manifest-helpers.ts),
  and [per-module scope selection](../packages/eve/src/compiler/load-binding-namespace.ts).
- [`defineState`](../packages/eve/src/public/definitions/state.ts) and
  [context serialization](../packages/eve/src/context/serialize.ts): named durable
  slots, reserved-prefix validation, and unknown-key handling.
- [Bundle context codec](../packages/eve/src/runtime/sessions/runtime-context-keys.ts)
  and [durable artifact sources](../packages/eve/src/runtime/durable-compiled-artifacts-source.ts):
  serialized bundle selector and node identity, not historical mount ownership.
- [Session handoff](../packages/eve/src/execution/session/handoff.ts) and
  [checkpoint validation](../packages/eve/src/execution/session/handoff-steps.ts).
  The [session-upgrade plan](./single-workflow-session-upgrades.md) explains why
  refusing a successor leaves the old owner responsible rather than migrating it.
