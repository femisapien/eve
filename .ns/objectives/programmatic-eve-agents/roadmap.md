# Roadmap

## Work

- [x] Settle the public authoring, hosting, and durable-definition contract.
      Confirmed `createAgent` with flat configuration, string/keyed instructions, and keyed existing tool/channel definitions; explicit default-export entry selection through Next.js `withEve`; registration-key identity; existing defaults; no implicit filesystem discovery. Retain the separate service for local development and Vercel production.
      Evidence: user-confirmed interface example and lifecycle recorded in `objective.md` and `updates/20260928T231133Z-programmatic-authoring-contract.md`. Source inspection supports the proposed reuse but is not runtime validation. Engineering follow-ups are addressed below. The later repo-only tracking decision removes the issue-link prerequisite.

- [x] Resolve the build-binding, isolation, reconstruction, and routing design.
      Confirmed generated entry imports with member selection, application-root/registration-key resource isolation, no adjacent discovery throughout preparation, and existing deployment affinity and idle handoff. Retain Next.js forwarding only for service `/eve/v1/*`; arbitrary paths and conventional Workflow webhooks receive no new automatic forwarding.
      Evidence: user-approved source-grounded proposal recorded in `updates/20260928T233326Z-entry-bindings-and-registration-isolation.md`. Source inspection identified concrete missing capabilities; no implementation or runtime qualification is claimed.

- [x] Finalize the implementation proposal in the Objective files.
      Specified literal map-key validation and deterministic ordering, existing collision semantics, entry-backed namespace projection, and typed host selection with internal environment transport through generated commands. Keep proposal and progress repo-only; no GitHub issue is required.
      Evidence: `objective.md` “Implementation Proposal” defines three delivery slices and their behavioral evidence; `updates/20260929T000301Z-implementation-proposal.md` records source grounding and remaining runtime risks. This completes proposal work only, not implementation or runtime qualification.

- [x] Connect programmatic definitions to shared compilation.
      Adapt `createAgent` values from the explicitly selected module into existing source composition, normalization, and executable-binding machinery. Preserve existing defaults and configuration controls; use map keys for primitive identity and the registration key for agent identity. Resolve filesystem-shaped assumptions without introducing a parallel compiler or implicit discovery in entry mode.
      Evidence: `entry-sources.test.ts` covers filesystem-equivalent configuration/defaults/overrides, key validation, ordering, static/dynamic instructions, disable behavior, and missing selected members. `entry-sources.scenario.test.ts` compiles explicit entries without adjacent discovery, preserves identity across an entry move, and executes a bundled tool, dynamic model, and dynamic instructions in a fresh process after the authored tree is removed. Workspace build/typecheck/unit tests, focused scenarios, invariant guard, and docs checks pass. See `updates/20260929T125323Z-shared-entry-compilation.md`. This is executable-definition reconstruction, not durable-session recovery or host isolation.

- [ ] Deliver HTTP mounting with normal eve protocol and durable-session recovery.
      Extend Next.js `withEve` and the separate eve service build/dev pipeline to accept explicit entries and named identities. Integrate bundled definitions with existing runtime bootstrap and Workflow infrastructure for local development and Vercel production. Preserve channel authentication and establish reconstruction on workers rather than relying on request-local callback registration.
      Progress: the eve CLI hosts one entry under `eve dev`/`eve build`/`eve start` through internal `EVE_INTERNAL_AGENT_SELECTION`, without adjacent agent, extension, or instrumentation discovery (`updates/20260929T143000Z-cli-entry-selection-hosting.md`). Next.js `withEve`, generated service commands, registration-scoped resources, and recovery evidence remain.
      Evidence: an eve client interacts with a mounted programmatic agent and exercises instructions and an inline tool; restart or worker-recovery coverage demonstrates durable continuation. Required fixture-owned end-to-end coverage passes in CI.

- [ ] Publish and document the supported interface.
      Ship public exports and release notes, and document a complete programmatic-authoring and HTTP-mounting example, required build integration, supported capabilities, and reconstruction restrictions. Verify that existing filesystem authoring remains supported.
      Evidence: the documented example is behaviorally validated, compatibility coverage and relevant repository checks pass, and published documentation passes `pnpm docs:check`.

## Parked

Programmatic authoring of connections, skill packages with assets/scripts directories, hooks, schedules, extensions, and subagents remains deferred. Channels and `defineSkill` skills are included in the initial scope through existing definitions.

In-process HTTP embedding, self-hosted production qualification, additional framework integrations, named-export entry selection, and full authoring parity remain deferred. Arbitrary request-local closure persistence and new revision-pinning guarantees are not part of the contract. Additional automatic forwarding for custom paths outside `/eve/v1/*`, including conventional Workflow webhook paths, is deferred.
