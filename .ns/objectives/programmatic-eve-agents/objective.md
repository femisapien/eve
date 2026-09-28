# Programmatic eve Agents

## Thesis

Developers can define a full eve agent through a public programmatic interface instead of a prescribed filesystem layout, then mount it into an HTTP server with normal eve protocol and durable-session behavior. This changes how agents are authored, not their execution guarantees.

## Scope

Accept instructions and named tool definitions through ordinary function arguments. Connect those definitions to shared compilation and execution machinery, and provide a supported HTTP mounting path usable by an eve client. Build integration and generated artifacts are acceptable; authors must not need to arrange definitions in an `agent/` directory tree.

Preserve filesystem authoring. Initial coverage includes instructions, tools, channels, and existing agent configuration. The supported hosting path is a separate eve service mounted through Next.js `withEve`, with local development and Vercel production demonstrated. Deliver public documentation and behavioral coverage alongside the interface.

## Confirmed Contract

This is the agreed target interface, not an implemented API.

- Add `createAgent` from `eve`, accepting existing configuration fields at the top level alongside `instructions`, `tools`, and `channels`. It returns a definition; calling it does not compile, start a service, or begin a session. Keep `defineAgent` configuration-only.
- Accept instructions as a string shorthand or a keyed map of existing static/dynamic instruction definitions. Preserve existing roles and lifecycle behavior.
- Accept tools and channels as keyed maps of existing eve definitions, including `defineTool` values and `eveChannel` configuration. Keys supply primitive identity instead of filenames.
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

## Non-Goals

- A separate lightweight or non-durable agent runtime.
- Eliminating compilation, generated artifacts, or all filesystem access.
- Full programmatic parity for channels, connections, skills/assets, hooks, schedules, extensions, and subagents as a prerequisite to completion.
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

The existing programmatic source graph and module-map machinery can support application definitions without a parallel compiler. This is provisional: source inspection found internal in-memory sources in `packages/eve/src/compiler/source-graph.ts`, registry inputs to `compileAgentManifest` in `packages/eve/src/compiler/normalize-manifest.ts`, and in-memory module-map construction in `packages/eve/src/compiler/module-map.ts`. Those facilities are not yet a supported public constructor or mounting interface.

Build integration and generated artifacts are acceptable. The desired simplification is removal of the prescribed authoring layout, not removal of durable execution infrastructure.

### Risks

Definitions and callbacks must be reconstructible when execution resumes on another worker. A function captured only in a transient request is not a durable definition. The interface must establish stable identity and reconstruction semantics without pretending to serialize arbitrary closures.

The earlier risk of needing an independently embeddable HTTP host is narrowed by the decision to retain the separate-service architecture. Host preparation still takes an application root and requires changes to carry explicit entry and identity through compilation, development reloads, service output, and Workflow initialization. Integration feasibility remains unvalidated.

The routing scope is settled: accepting channel definitions does not automatically expose paths outside `/eve/v1/*` through Next.js. Documentation must make this limit explicit, including conventional Workflow webhooks, and preserve service-side authentication.

Source inspection confirmed that the current generated programmatic loader knows framework registries, not arbitrary application definitions. The approved import-and-selection design closes that design gap, but executable reconstruction remains unvalidated until implementation.

Source inspection also confirmed same-root collisions in development process keys, active-generation pointers, local Workflow storage, local output, and summaries. Existing named Vercel service outputs provide only partial isolation. The approved registration-scoped design must address all of these resources. Preserve existing deployment-upgrade semantics rather than promising new version-pinning or migration behavior.

Skipping initial discovery alone does not satisfy entry authority: later host preparation discovers workspace extensions and instrumentation. Entry mode must suppress those paths too, without removing framework defaults.

A second authoring interface could drift in validation, defaults, composition, or execution behavior. Reuse shared normalization and runtime machinery, and verify filesystem compatibility as part of delivery.

## Open Questions

The build-binding, registration-isolation, reconstruction, and routing design questions are resolved above. Implementation still must specify map-key validation and collision diagnostics, the internal binding representation, and propagation through generated service commands; these details must preserve the confirmed contract.

Tracking is repo-only by explicit user decision. Keep the proposal, decisions, and progress in this Objective's files; do not create a GitHub issue or require one before proceeding. Do not fabricate issue frontmatter or move the proposal into `research/`, whose issue-backed document convention remains unchanged. This supersedes the earlier issue-provenance follow-up; see [the tracking decision](updates/20260928T235646Z-repo-only-tracking.md).

Design context: `research/programmatic-agent-sources.md` describes the existing internal source model. Runtime artifact installation lives in `packages/eve/src/runtime/loaders/bundled-artifacts.ts`; durable bundle references live in `packages/eve/src/runtime/sessions/runtime-context-keys.ts`; Workflow-backed execution begins in `packages/eve/src/execution/workflow-runtime.ts`. Initial exploration was source inspection only, not a validated prototype.
