# Programmatic eve Agents

## Thesis

Developers can define a full eve agent through a public programmatic interface instead of a prescribed filesystem layout, then mount it into an HTTP server with normal eve protocol and durable-session behavior. This changes how agents are authored, not their execution guarantees.

## Scope

Accept instructions and named tool definitions through ordinary function arguments. Connect those definitions to shared compilation and execution machinery, and provide a supported HTTP mounting path usable by an eve client. Build integration and generated artifacts are acceptable; authors must not need to arrange definitions in an `agent/` directory tree.

Preserve filesystem authoring. Initial coverage includes instructions, tools, skills, channels, and existing agent configuration. The supported hosting path is a separate eve service mounted through Next.js `withEve`, with local development and Vercel production demonstrated. Deliver public documentation and behavioral coverage alongside the interface.

## Confirmed Contract

This is the agreed target interface. The constructor and shared-compilation slice are implemented; Next.js mounting and durable-session recovery remain unimplemented.

- Add `createAgent` from `eve`, accepting existing configuration fields at the top level alongside `instructions`, `tools`, and `channels`. It returns a definition; calling it does not compile, start a service, or begin a session. Keep `defineAgent` configuration-only.
- Accept instructions as a string shorthand or a keyed map of existing static/dynamic instruction definitions. Preserve existing roles and lifecycle behavior.
- Accept tools and channels as keyed maps of existing eve definitions, including `defineTool` values and `eveChannel` configuration. Accept skills as a keyed map of `defineSkill` or dynamic skill definitions. Keys supply primitive identity instead of filenames.
- Extend `withEve(nextConfig, { agents: { support: { entry: "./src/support.ts" } } })` to select a module's default-exported `createAgent` definition. The location is application-chosen, not a required authoring layout. Named export selection is deferred.
- Use the registration key (`support`) as stable agent identity and the named public route prefix (`/eve/support/v1`). Moving the entry file preserves identity; renaming the registration key changes identity and does not imply automatic session migration. Do not require a redundant agent name in the definition.
- Explicit entry selection is authoritative: do not discover or merge adjacent filesystem-authored primitives. Preserve existing framework defaults, configuration controls, composition rules, and validation. Filesystem authoring remains a separate supported entry mode.
- Retain the separate eve service and existing Next.js proxy/service deployment architecture, not an in-process Next.js handler. Preserve normal eve protocol and Workflow execution.
- Compile selected definitions through shared machinery, bind executable values into the service bundle, and reconstruct them from deployed application code on workers. Durable state contains data and references, not serialized closures. Worker-local dependencies are permitted; transient request-local captured state cannot be required for recovery.
- Definition imports may run during compilation/build and on workers. Importing a definition must not implicitly launch background work. Build integration and generated artifacts are permitted.

The complete authoring-and-mounting example and source evidence are recorded in [the contract decision](updates/20260928T231133Z-programmatic-authoring-contract.md).

## Confirmed Integration Design

The user approved the source-grounded proposal in [the integration decision](updates/20260928T233326Z-entry-bindings-and-registration-isolation.md). This is a design decision, not runtime validation.

- Generated module maps import the selected entry and select its configuration or keyed primitive definitions. Compile-time and runtime selection use the same semantics. Reuse existing normalization, static instruction capture, and runtime bootstrap; do not depend on a build-process registry or serialize closures.
- Definition structure must be reproducible across build and worker imports. Runtime credentials may vary, but transient request state must not determine the available tools or channels.
- Scope hosted resources by application root and registration key, not entry filename. Isolate processes, discovery/lock files, active generations, local Workflow data, published output, and summaries. Set the compiled agent name from the registration key so queue identity follows it.
- Entry mode bypasses adjacent primitive discovery throughout host preparation, including extension and instrumentation discovery outside the compiler. Keep framework defaults and ordinary package, environment, and TypeScript resolution. Reloads retain entry selection and registration identity; shared dependencies may rebuild multiple registrations without mixing their artifacts.
- Fresh workers reconstruct definitions from their deployed artifacts. Preserve existing deployment affinity and eligible-idle-session handoff to the exact accepting deployment. Do not switch active work silently or promise new revision pinning.
- Retain narrow Next.js forwarding: service `/eve/v1/*` maps to `/eve/<key>/v1/*`, including custom channels within that namespace. Do not add automatic forwarding for arbitrary paths or `/.well-known/workflow/v1/webhook/*`. Preserve existing service-side Workflow queue delivery and channel authentication.

## Implementation Proposal

This specifies the remaining engineering details of the confirmed design. It is a source-grounded proposal, not an implemented or runtime-qualified API.

### Names, ordering, and diagnostics

- Treat maps as own enumerable string-keyed records. Keys are literal identities, not import paths; never trim, case-fold, strip extensions, or silently rename them. Reject malformed keys before constructing compiler slots.
- Tool keys use the existing tool-name grammar, `[A-Za-z][A-Za-z0-9_-]{0,63}`, with no nesting. Channel keys use the existing channel-segment validator, also with no nesting: lowercase names (including the existing optional leading dot) or bracketed parameter names. Channel identity does not determine its HTTP routes. Instruction keys use the tool-key grammar as a new, explicit restriction on this new map API; filesystem instruction naming is unchanged. Reuse existing validators rather than changing filesystem rules.
- Project maps to logical slots `tools/<key>.ts`, `channels/<key>.ts`, and `instructions/<key>.ts`; configuration occupies `agent.ts`. A string instruction becomes static system instructions at `instructions/default.ts`. String and map forms are alternatives, so no implicit merge with a `default` key occurs. Order application candidates by logical path, independent of object insertion order, while preserving framework-first composition and the existing normalizers' lifecycle ordering.
- Preserve application-over-framework slot selection, framework tool controls, disable sentinels, and final compiled-name uniqueness checks. Reusing a key across primitive categories is valid; duplicate selected slots within one layer/form remain errors. JavaScript has already resolved overwritten object properties before eve receives a map; do not promise duplicate-property detection.
- Preserve channel route planning: reserved host overlaps and duplicate routes from one source are errors; overlaps across sources retain the existing winner/shadow diagnostic behavior, not a new blanket collision error. An authored `channels.eve` replaces that framework slot; adding a differently named channel with overlapping routes does not imply replacement.
- Errors must identify the registration, entry module, primitive category/key, violated rule, and conflicting source when applicable. Missing/invalid default exports and missing selected members fail without filesystem fallback. Use bounded, escaped labels rather than dumping definitions, callback source, credentials, or configuration values.

### Entry bindings through shared compilation

- `createAgent` produces a distinguishable aggregate definition without evaluating callbacks or starting work. Its flat public input is separated internally into existing configuration and the three primitive collections. Validate configuration through the current normalizer; do not pass aggregate-only fields into `normalizeAgentDefinition`, which rejects unknown keys. Preserve dynamic model and instruction definitions as executable values.
- Extend `AgentModuleBacking` with an internal entry-backed variant carrying the entry's source path, build external dependencies, and a bounded projection: configuration, string instructions, or one keyed member of instructions/tools/channels. This is not an arbitrary property-path interpreter and not an application registry. Keep source IDs node-scoped and derived from category/key, independent of the entry filename; keep the physical entry path only in backing/provenance.
- A shared eve-owned projection helper converts the selected value to an ordinary `{ default: value }` module namespace. Compile-time loading, in-memory module maps, and generated module maps use that same helper. Keep `ModuleSourceRef` and runtime export resolution unchanged: they still select a top-level default export. Validate the aggregate and use own-property member access; never execute a callback merely to select it.
- Generated maps statically import the entry and call the packaged helper for selected runtime bindings. Reuse imports/evaluation within a compilation generation or worker; do not introduce process-global definition registration. Preserve authored-module bundling, external dependency handling, Workflow transforms, and existing namespace-factory memoization after projection. Config bindings used for dynamic models must remain available at runtime, as must tools, channels, and dynamic instructions; static instructions remain captured in the manifest.
- Add entry adaptation before shared source composition/normalization and artifact writing, not a second compiler. Feed application candidates alongside framework defaults without fabricating authored files or invoking primitive discovery. Carry entry authority through extension/instrumentation preparation and reloads. Missing selected members fail during worker reconstruction; reproducible membership remains an authoring requirement, not a promise to serialize closures or prove arbitrary build/runtime equivalence.

### Host selection and command propagation

- Model each named `withEve` registration as either filesystem `root` or explicit `entry`, never both; retain existing string/root forms. Entry mode uses the Next.js application root (the current config resolution base), resolves relative entries there, and does not infer an application root or identity from the entry's directory. Reuse `assertValidPublicAgentName` for registration keys.
- Carry one resolved internal host-selection value through Next normalization, service generation, CLI initialization, the local-server child JSON payload, host preparation, and the rebuild coordinator. Entry selection carries the resolved application root, entry path, and registration key; filesystem selection retains existing behavior. Resolve entry mode before CLI workspace selection/root discovery, and reject mixing it with `--agent`, which selects filesystem workspace members.
- Use one internal environment envelope, `EVE_INTERNAL_AGENT_SELECTION`, to transport entry path and registration key across generated shell/subprocess boundaries; interpret paths relative to the explicit application-root cwd. Validate and convert it once at the process boundary, then pass typed options, including through the child-process whitelist. Next development spawns set it directly; generated Vercel service wrappers shell-quote/export it before the selected build command, including user overrides. No new public CLI flags are required for this slice. Filesystem spawns must not inherit a stale entry envelope. Custom commands must eventually invoke the eve build path and preserve its environment; bypassing that path is not a supported entry build.
- Keep published command paths relocatable: use application-root-relative entry paths in generated configuration, resolving absolute paths only inside the receiving process. Preserve existing public-prefix, workspace-member, and output-directory transport, without treating an entry registration as a filesystem workspace member. Vercel contributions currently generate build/optional dev commands, not a start command; production loads bundled artifacts without importing the source entry again.
- Scope process/lock/discovery keys, generation pointers, local Workflow data, published compiler/build output, and summaries by resolved application root plus registration key. Use one shared scope derivation; the entry path is selection metadata, not persistent identity. Reuse existing named Vercel output isolation. Local production lookup must use the same scoped output as build rather than the root's fixed `.output/server/index.mjs`. Persist/compare selection metadata before reusing a running host so an entry move rebuilds or replaces that host without changing resource identity. Keep filesystem-mode locations unchanged.

### Delivery slices and behavioral evidence

1. **Shared compilation:** constructor/aggregate validation, entry adaptation, binding projection, and emitted module-map support. Unit/in-memory integration coverage owns invalid keys, projected definitions, deterministic ordering, override/disable behavior, and equivalent effective configuration across authoring modes. A bundler-backed scenario must import an emitted map in a fresh process and exercise executable definitions, including a dynamic model/instruction path; comparing generated source strings is insufficient.
2. **Mounting and recovery:** carry selection through Next, generated service builds, development reload, and production artifacts, with registration-scoped resources and no adjacent discovery. Scenario evidence owns two registrations in one app, transitive-dependency reload without cross-registration state/artifact contamination, entry relocation with stable identity, and a nearby filesystem agent/extension/instrumentation that is not loaded. Exercise the actual generated build-command boundary, including a custom build command. An eve client must use authenticated mounted routes and an inline tool, then continue the same durable session after a genuine process/worker boundary with persisted data; starting a new session or replaying an in-memory callback is not recovery evidence. Fixture-owned CI evals qualify Next.js/Vercel ingress and worker continuation, including rejected unauthenticated access and unchanged custom-route forwarding limits.
3. **Publication:** ship exports, changesets, and a complete documented example with build requirements, reconstruction restrictions, identity semantics, and channel-route limits. Include filesystem compatibility evidence; run relevant repository checks and `pnpm docs:check`. Package changes need changesets as they land, not only in the final slice. E2E evidence is CI-only and must be recorded before claiming the Objective complete.

Extend existing behavior-owning tests where possible; do not duplicate the same contract at every layer. Use tier-specific Vitest configs, inline scenario descriptors, and deterministic CI fixtures. Routine checks are completion evidence, not additional roadmap work.

## Non-Goals

- A separate lightweight or non-durable agent runtime.
- Eliminating compilation, generated artifacts, or all filesystem access.
- Full programmatic parity for channels, connections, skill assets/packages, hooks, schedules, extensions, and subagents as a prerequisite to completion.
- In-process embedding in Next.js or an arbitrary application HTTP server.
- Supporting every HTTP server or deployment target in the initial release; self-hosted production and non-Next.js convenience integrations are deferred.
- Request-local agent registration, serialization of arbitrary closures, or new revision-pinning guarantees.

## Completion Criteria

- The confirmed `createAgent` interface accepts instructions, named tools, and channels alongside existing configuration without a prescribed authoring directory layout.
- Next.js `withEve` accepts an explicit entry module and registration identity, with no implicit filesystem discovery, and mounts a separate eve service through normal eve protocol behavior. Demonstrate local development and Vercel production with an eve client.
- Channel authentication remains configured through existing channel definitions. Document which custom channel routes the Next.js mounting path exposes rather than implying arbitrary route forwarding.
- Behavioral evidence demonstrates durable-session recovery, not merely a successful initial request. Executable definitions are available when execution resumes on another worker or after restart.
- Programmatic authoring uses shared compilation and execution semantics rather than a parallel agent implementation, and existing filesystem authoring remains supported.
- Public documentation explains setup, build requirements, supported capabilities, and restrictions on definition reconstruction. Relevant behavioral tests and repository checks pass; required end-to-end evidence is obtained in CI.

## Assumptions and Risks

### Assumptions

The shared source graph and module-map machinery now compile `createAgent` entries without a parallel compiler. Entry candidates reuse composition, normalization, lifecycle classification, and artifact writing. Unit coverage compares effective definitions against filesystem inputs; a bundler-backed fresh-process scenario exercises executable reconstruction. Public mounting remains a separate delivery slice.

Build integration and generated artifacts are acceptable. The desired simplification is removal of the prescribed authoring layout, not removal of durable execution infrastructure.

### Risks

Definitions and callbacks must be reconstructible when execution resumes on another worker. A function captured only in a transient request is not a durable definition. The interface must establish stable identity and reconstruction semantics without pretending to serialize arbitrary closures.

The earlier risk of needing an independently embeddable HTTP host is narrowed by the decision to retain the separate-service architecture. Host preparation still takes an application root and requires changes to carry explicit entry and identity through compilation, development reloads, service output, and Workflow initialization. Integration feasibility remains unvalidated.

The routing scope is settled: accepting channel definitions does not automatically expose paths outside `/eve/v1/*` through Next.js. Documentation must make this limit explicit, including conventional Workflow webhooks, and preserve service-side authentication.

The generated loader now projects application entry imports through the same helper used by compile-time and in-memory loaders. A fresh-process scenario invokes an inline tool, dynamic instructions, and a dynamic model from the bundled map after the authored source tree is removed. This de-risks executable reconstruction; it does not establish persisted-session recovery, deployment affinity, or host resource isolation.

Source inspection also confirmed same-root collisions in development process keys, active-generation pointers, local Workflow storage, local output, and summaries. Existing named Vercel service outputs provide only partial isolation. The approved registration-scoped design must address all of these resources. Preserve existing deployment-upgrade semantics rather than promising new version-pinning or migration behavior.

Skipping initial discovery alone does not satisfy entry authority: later host preparation discovers workspace extensions and instrumentation. Entry mode must suppress those paths too, without removing framework defaults.

A second authoring interface could drift in validation, defaults, composition, or execution behavior. Reuse shared normalization and runtime machinery, and verify filesystem compatibility as part of delivery.

## Open Questions

The design questions, including map-key validation/collision diagnostics, the entry-binding representation, and generated-command propagation, are specified above. No additional public-contract decision blocks implementation. The remaining uncertainty is runtime feasibility: validate emitted entry bindings, same-root isolation, discovery exclusion, and durable recovery rather than treating this proposal as proof. If implementation requires changing the confirmed contract, return for a decision instead of silently narrowing it.

Tracking is repo-only by explicit user decision. Keep the proposal, decisions, and progress in this Objective's files; do not create a GitHub issue or require one before proceeding. Do not fabricate issue frontmatter or move the proposal into `research/`, whose issue-backed document convention remains unchanged. This supersedes the earlier issue-provenance follow-up; see [the tracking decision](updates/20260928T235646Z-repo-only-tracking.md).

Implementation evidence: [shared entry compilation](updates/20260929T125323Z-shared-entry-compilation.md) records the delivered compiler slice and remaining host boundaries. Internal `compileAgentInWorkspace` accepts `entrySelection: { appRoot, entry, registration }`; future host wiring must supply registration-scoped artifact locations and suppress extension/instrumentation discovery before and after compilation.

Design context: `research/programmatic-agent-sources.md` describes the existing internal source model. Runtime artifact installation lives in `packages/eve/src/runtime/loaders/bundled-artifacts.ts`; durable bundle references live in `packages/eve/src/runtime/sessions/runtime-context-keys.ts`; Workflow-backed execution begins in `packages/eve/src/execution/workflow-runtime.ts`. Initial exploration was source inspection only, not a validated prototype.
