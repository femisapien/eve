# Shared entry compilation

## Summary

Implemented the shared-compilation slice under the user's explicit confirmation of the current-session recommendation. `createAgent` collects flat configuration and keyed primitives without invoking callbacks. Explicit internal compiler selection adapts the default-exported definition to entry-backed source slots, bypassing filesystem primitive discovery and retaining shared normalization, defaults, overrides, disable policies, and lifecycle classification.

Compile-time, in-memory, generated, and authored-source module maps project entry members through one helper. Compiler preparation reuses the imported namespace for its compilation; worker bundles statically import deployed definitions. Entry moves retain registration and logical source identity. The bundler's package-root lookup now includes flat application roots rather than beginning above them.

Published documentation states the current boundary: the constructor exists, but CLI and Next.js mounting still require filesystem authoring. A patch changeset accompanies the package edits. The public authoring capability contract advances from epoch 21 to 22 with a retained epoch-21 compatibility example; existing contract history and guard baselines remain unchanged.

## Objective Impact

The shared-compilation roadmap row is complete. `entry-sources.test.ts` covers validation, deterministic ordering, static roles, dynamic bindings, default controls, disable behavior, missing members, and equivalent effective configuration/tools/instructions against filesystem source manifests. `entry-sources.scenario.test.ts` compiles with an adjacent filesystem agent that throws if imported, moves the selected entry without changing identity, bundles the emitted map, removes the authored tree, then invokes a tool, dynamic model, and dynamic instructions in a fresh Node process. The channel definition also reconstructs.

Validation performed:

- `pnpm build` and `pnpm typecheck`: passed.
- `pnpm test:unit`: passed after moving the local-node result type to the existing compiler types module to preserve the production file-length cap.
- Tier-configured compiler unit suite: passed.
- Scenario tier: `entry-sources.scenario.test.ts` and `module-lifecycle.scenario.test.ts` passed.
- `pnpm fmt`, `pnpm lint`, `pnpm guard:invariants`, and `pnpm docs:check`: passed; lint reports existing warnings outside this slice.
- Package TypeScript checks passed after the final compiler/test edits.

Evidence is local and uncommitted on `plan-programmatic-eve-agents`; the committed diff against `main` contained Objective design records only. No PR, merge, deployment, or CI evidence is claimed. Existing Semantic Updates were not edited. No closure marker is appropriate: mounting/recovery and publication remain open.

## Follow-Ups

Wire the internal `compileAgentInWorkspace` `entrySelection: { appRoot, entry, registration }` input into the named Next.js/service pipeline. Callers must supply registration-scoped artifact locations and enforce entry authority through host extension/instrumentation preparation and reloads. Neither `compileAgent`'s default artifact location nor the current host pipeline provides registration isolation yet.

Fresh-process executable reconstruction is not persisted-session recovery. The next slice must prove authenticated mounted access, same-root registration isolation, generated-command propagation, and durable continuation after a genuine process/worker boundary. CI-only fixture qualification and complete mounting documentation remain required before Objective completion.
