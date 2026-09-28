# Entry bindings and registration isolation

## Summary

The user approved the integration proposal after source investigation and an explanation of the module map. This builds on the immutable [authoring contract](20260928T231133Z-programmatic-authoring-contract.md); it does not change the selected separate-service architecture or authorize implementation, commits, or GitHub writes.

### Approved design

- Import the selected application entry into the generated module map and select configuration or keyed definitions from its default export. Share selection semantics across compilation and runtime. The module map maps source IDs, scoped by agent node, to loaded module namespaces; the manifest refers to those IDs and exports. Do not substitute a process-local application registry for deployed executable imports.
- Preserve existing normalizers and composition. Static instructions become manifest content; dynamic instructions and executable tools retain runtime references. Definition structure must be reproducible between build and worker imports. Credentials may vary, but transient request state must not determine tool/channel membership.
- Use application root plus registration key to scope hosted resources. Isolate dev processes and lock/discovery files, active generations, local Workflow storage, final output, and summaries. Use the registration key for compiled agent name and queue identity. Entry moves preserve identity; registration renames do not imply migration.
- Suppress adjacent primitive discovery throughout entry-mode preparation, not only at compiler entry. This includes extension and instrumentation discovery. Preserve framework defaults, package/TypeScript/environment resolution, and dependency-aware reloads. Reloads retain the selected entry and registration; shared dependencies may rebuild multiple registrations without mixing artifacts.
- Fresh workers load their deployed artifacts. Preserve exact-deployment selection, ordinary resume affinity, and existing eligible-idle-session handoff. Active work does not silently move to new code. Do not add revision-pinning guarantees or serialize closures.
- Keep Next.js forwarding narrow: service `/eve/v1/*` becomes `/eve/<key>/v1/*`. Custom channels in that namespace are included. Arbitrary paths and conventional `/.well-known/workflow/v1/webhook/*` paths are not automatically forwarded. Existing service-side Workflow queue delivery remains separate. Preserve channel authentication; proxy protection alone is not a service auth policy.

### Source evidence

Paths are relative to `packages/eve/src/` unless stated otherwise. Inspection used repository HEAD `827fe9b06`.

- `compiler/module-map.ts`, `createCompiledModuleMapSource` and `createProgrammaticCompiledModuleMap`: generated maps import filesystem namespaces or call a programmatic loader; in-memory maps can accept caller registries. `framework/sources/registry.ts`, `loadFrameworkProgrammaticModule`, supplies only framework registrations. Generated backing metadata does not preserve application loader closures.
- `internal/authored-module.ts` and `runtime/resolve-helpers.ts`: export selection is currently top-level default/named export selection, not nested aggregate-member selection. `compiler/source-graph.ts` separates logical slots from backing modules; `compiler/project-sources.ts` projects candidates into shared primitive normalization.
- `compiler/artifacts.ts`, `writeCompilerArtifacts`, and `compiler/compile-agent.ts`: ordinary artifact production does not yet expose the aggregate-entry input. `compiler/normalize-manifest.ts`, `compileAgentManifest`, already accepts explicit manifests and source registries without invoking initial filesystem discovery.
- `internal/authored-module-loader.ts`, `bundleAuthoredModuleMapForGeneration`: the whole generated map passes through authored-source bundling and Workflow directive processing. Entry imports must remain visible to this path. `internal/application/compiled-artifacts.ts` installs the executable map and manifest through the shared bootstrap.
- `public/next/index.ts` and `public/next/server.ts`: registrations currently accept roots; explicit registration names identify mounts/services but do not supply compiler identity. Dev/production process reuse and Next dev discovery files are root-keyed.
- `internal/nitro/host/prepare-application-host.ts`: dev and production preparation call root-based compilation. `internal/nitro/host/dev-authored-rebuild-coordinator.ts` re-enters preparation without an entry selection. `internal/nitro/dev-runtime-artifacts.ts` keeps one active generation pointer per app root.
- `internal/application/build-workspace.ts`: invocation scratch directories are isolated, but final output and summary paths remain root-based by default. `internal/vercel/eve-service-contribution.ts` already isolates named service outputs; it does not select distinct entries for same-root builds.
- `internal/workflow/local-world-data-directory.ts` and `internal/nitro/host/dev-workflow-world-setup.ts`: local Workflow storage and active-generation lookup use application root. Queue names alone do not isolate this local state.
- `internal/nitro/host/workspace-extensions.ts` discovers extension mounts during host preparation. `internal/authored-runtime-modules.ts` calls `resolveInstrumentationLayout` from `internal/instrumentation-layout.ts`, which reads authored instrumentation from disk. These later discovery paths must honor explicit-entry authority.
- `runtime/sessions/runtime-context-keys.ts`, `BundleKey`: persisted context contains a node ID and artifact selector, not functions or historical bundle contents. The deserializer reconstructs the runtime bundle. `execution/workflow-runtime.ts` selects exact deployments; `execution/session/handoff.ts` and `handoff-steps.ts` implement idle transfer and target validation. Published semantics are in `docs/concepts/execution-model-and-durability.mdx`.
- `public/next/index.ts` and `internal/vercel/eve-service-contribution.ts` forward the eve protocol namespace. `internal/nitro/host/application-route-registry.ts` exposes a wider service route set. `eve-channel/index.ts` defines conventional Workflow webhooks outside the forwarded namespace. The dedicated flow queue trigger in `internal/nitro/host/vercel-build-output-config.ts` is distinct from Next public ingress.

## Objective Impact

The four integration-design questions are resolved. The roadmap now distinguishes this completed design decision from the remaining detailed proposal and issue provenance. Runtime feasibility remains unvalidated: source inspection is not a build, model run, restart demonstration, or CI result.

The investigation made two risks concrete: same-root registrations collide beyond build output, and later host preparation can discover primitives even if initial compiler discovery is skipped. The implementation must address both rather than merely add an `entry` field to `withEve`.

The Objective remains open. Its implementation, documentation, and durable-runtime completion criteria are not met. The research issue prerequisite is not an Objective-wide blocker. No external record was created; the user's design approval was not treated as explicit authorization to create a GitHub issue.

Local evidence: branch `main` equals `origin/main`; there is no committed feature diff or tracked implementation diff. Existing untracked Objective files were considered and preserved. Graphite-parent and PR evidence are irrelevant to this source-only design update. No existing Semantic Update was modified.

## Follow-Ups

- Obtain an appropriate issue reference or explicit permission to create a feature-tracking issue before adding the required issue-backed document under `research/`.
- Specify the internal import/member-selection representation, map-key grammar and collision diagnostics, and entry/identity propagation through generated commands. These details must preserve the approved design rather than reopen the public contract.
- Implement compiler binding and registration-scoped preparation through shared mechanisms. Validate two registrations in one app, reload isolation, adjacent-discovery exclusion, filesystem compatibility, and fresh-worker durable continuation. Obtain Vercel production evidence in CI; do not infer it from initial HTTP success.
