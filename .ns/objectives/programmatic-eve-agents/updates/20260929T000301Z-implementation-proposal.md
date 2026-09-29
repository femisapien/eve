# Implementation proposal

## Summary

Finalized the proposal in `objective.md` under the user's confirmation of the bounded `objective-next` recommendation. This is engineering design based on source inspection, not an implemented API or runtime qualification. The confirmed public contract and repo-only tracking decision are unchanged.

The proposal specifies literal, flat primitive map keys; deterministic logical-path ordering; existing source-slot and channel-route collision rules; an entry-backed binding variant with bounded namespace projection; and explicit host-selection propagation through generated service commands. The internal `EVE_INTERNAL_AGENT_SELECTION` envelope transports entry/registration selection even when the generated service uses a custom build command. No public CLI flags or new runtime execution model are proposed.

Source grounding at `a8417713f` (paths relative to `packages/eve/src/`):

- `discover/grammar.ts` supplies distinct tool and channel validators. Filesystem instructions do not have the same explicit slug grammar; applying the tool grammar to new instruction map keys is a proposal decision, not a claim about current filesystem behavior.
- `compiler/source-graph.ts` owns canonical slots, precedence, and backing types. `compiler/source-graph-paths.ts` validates programmatic paths but not primitive names. `compiler/normalize-manifest.ts` composes framework/application candidates and checks final tool names. `compiler/channel-route-plan.ts` distinguishes reserved/same-source route errors from cross-source shadowing. The proposal preserves these differences rather than adding uniform collision errors.
- `compiler/load-binding-namespace.ts` and `compiler/module-map.ts` currently load filesystem namespaces or registry-backed programmatic namespaces. `compiler/normalize-helpers.ts` and runtime export resolution consume top-level exports. Projecting aggregate members to default-export namespaces allows those downstream consumers to remain unchanged. `internal/authored-definition/core.ts` rejects aggregate-only configuration fields; entry projection must separate those fields before normalization.
- `compiler/compile-agent.ts` and `compiler/artifacts.ts` currently enter through discovery. Entry adaptation must reach shared composition/artifact production without manufacturing an authored tree. `compiler/normalize-instructions.ts` captures static content and retains dynamic references; the binding design must preserve that distinction and dynamic model configuration.
- `public/next/index.ts`, `public/next/server.ts`, `cli/agent-command.ts`, and `cli/dev/local-server-child.ts` show that registration names currently do not carry compiler identity and that child serialization needs explicit propagation. Entry mode must be selected before filesystem workspace resolution.
- `internal/vercel/eve-service-contribution.ts` wraps build commands with cwd/output/prefix environment settings, including user overrides; it emits build/optional dev commands, not a start command. `public/next/server.ts` currently looks for fixed-root local production output. The proposal requires shared registration-scoped output lookup and relocatable generated entry paths.

## Objective Impact

The implementation-proposal roadmap row is complete. Three delivery slices remain: shared compilation, mounting with durable recovery, and publication. No new human decision or external blocker is required before implementation; source-grounded design does not resolve runtime feasibility risks.

Evidence requirements distinguish pure/in-memory compiler behavior, emitted-bundle reconstruction in a fresh process, same-root hosting/reload isolation, and actual persisted-session recovery through a process or worker boundary. Initial HTTP success alone cannot complete the mounting row. Vercel qualification remains CI-only.

Only this Objective's tracking was edited. The initial worktree was clean; the committed branch diff against Graphite parent `main` contained only this Objective's records. PR evidence was unnecessary for this proposal-only work. Existing semantic updates remain immutable. `ns objective check programmatic-eve-agents` and `git diff --check` passed for the completed record. No runtime tests, builds, public-doc checks, or CI runs were performed; no code or published docs changed.

## Follow-Ups

Implement the shared-compilation slice using the proposal's entry projection and identity rules. Preserve the agreed contract; return for a decision if implementation requires changing it. Add changesets with published-package changes, then obtain the distinct hosting/recovery and publication evidence before closing the Objective. No closure marker was written.
