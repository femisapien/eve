# Programmatic authoring and Next.js service contract

## Summary

A source-grounded design interview established the public authoring and hosting contract. The user confirmed the complete example and lifecycle, then requested that they be recorded. This is a design decision, not implemented or runtime-validated functionality.

### Confirmed interface

The proposed new constructor returns a definition without compiling, starting a server, or beginning a session. `defineAgent` remains configuration-only. Existing configuration fields stay flat; tool/channel map keys replace filenames as primitive identities. Instructions accept a string or a keyed map of existing static/dynamic instruction definitions.

```ts
// src/support.ts — an application-chosen location
import { createAgent } from "eve";
import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { lookupOrder } from "./order-tools"; // Existing defineTool value

export default createAgent({
  model: "openai/gpt-5.4",
  instructions: "Help users look up their orders.",
  tools: {
    lookupOrder,
  },
  channels: {
    eve: eveChannel({
      auth: [vercelOidc(), localDev()],
    }),
  },
});
```

This auth configuration illustrates service authentication, not a complete browser-user authentication policy. Applications use existing channel auth definitions for their needs; proxy protection does not replace service-side authorization.

```ts
// next.config.ts — nextConfig is the application's existing Next.js config
import { withEve } from "eve/next";

export default withEve(nextConfig, {
  agents: {
    support: { entry: "./src/support.ts" },
  },
});
```

The proposed `entry` selects the module's default export. The registration key `support` supplies stable agent identity and the public prefix `/eve/support/v1`. Moving the module does not change identity; renaming the registration key does, with no implied automatic migration. There is no redundant agent name in `createAgent`.

### Confirmed lifecycle

1. Author an aggregate definition through ordinary function arguments in a reloadable application module.
2. Pass the explicit entry and registration identity through `withEve` to the eve service's build/development pipeline. Do not discover or merge adjacent agent files.
3. Adapt the definition to shared composition and normalization, preserving existing defaults, configuration controls, override rules, and validation.
4. Package executable definitions in the service bundle with existing Workflow build/bootstrap machinery.
5. Expose normal eve endpoints through the existing separate-service Next.js integration, not an in-process handler. Initial qualification covers local development and Next.js/Vercel production.
6. Reconstruct definitions from deployed application code on workers. Persist data and references, not closures. Worker-local dependencies are allowed; transient request-local state cannot be required for recovery. Definition imports can run during builds and must not implicitly launch background work.

### Source-grounded findings

- `packages/eve/src/compiler/source-graph.ts`, `normalize-manifest.ts`, and `module-map.ts` already support internal programmatic sources and in-memory executable maps. Their public application-entry and durable build integration remain to be implemented.
- `packages/eve/src/public/next/index.ts` currently accepts roots, uses named route prefixes, and proxies to separate services. `withEve` does not embed the agent in the Next.js process. Its existing routing focuses on eve protocol paths.
- `packages/eve/src/internal/nitro/host/prepare-application-host.ts` prepares development/production hosts through root-based compilation. Explicit entries and identities must reach those paths, including generated build commands and reload handling.
- `packages/eve/src/internal/nitro/host/application-route-registry.ts` combines compiled channel routes with Workflow delivery. `packages/eve/src/internal/application/compiled-artifacts.ts` installs bundled definitions and initializes Workflow infrastructure. Retaining this host model avoids inventing a standalone HTTP runtime.
- `packages/eve/src/runtime/sessions/runtime-context-keys.ts` restores bundle references rather than arbitrary captured functions. Stable bindings and definition reconstruction must follow that model.
- `packages/eve/src/eve-channel/index.ts` and `apps/frameworks/next/agent/channels/eve.ts` establish the existing channel-auth authoring surface. Accepting channels is necessary to configure it without a filesystem fallback; arbitrary custom-route forwarding needs separate clarification.

Read-only GitHub searches for `programmatic` and `library` found [#2221](https://github.com/vercel/eve/issues/2221), a closed experimental embedded-execution spike. Its body explicitly excludes a supported interface and remote deployment validation. It is related history, not an appropriate tracking issue for this separate-service contract. No suitable issue was identified in those searches, and no external records were created or changed.

## Objective Impact

The public contract roadmap item is complete on user-confirmed design evidence. Initial scope now explicitly includes instructions, tools, channels, and existing configuration, with Next.js local development and Vercel production as the supported hosting path. Existing filesystem authoring remains supported separately.

The risk of extracting an independently embeddable HTTP runtime is avoided by the chosen service architecture. Compiler/build reuse remains an active assumption, not a proven result. Binding reconstruction, per-registration build isolation, deployment-upgrade behavior, and custom-channel routing remain engineering risks.

A new follow-up roadmap item retains those engineering questions and the legitimate issue-link prerequisite for a research proposal. Deferring the proposal does not block all source investigation; no Objective-wide Blocked Sentence is warranted. The Objective remains open and planning-only.

## Follow-Ups

- Resolve how selected entry exports generate stable executable bindings, including dynamic instruction callbacks, without adding function serialization or new revision-pinning promises.
- Establish isolated build output, development reloads, and service configuration per named registration.
- Specify the custom-channel routing boundary through Next.js while preserving service-side authentication.
- Obtain an appropriate issue reference before creating the public-interface proposal under `research/`; retain the agreed design in Objective tracking until then.
- Implement and validate shared compilation plus the Next.js/Vercel path, including durable recovery and filesystem compatibility. No model execution, prototype, build, test suite, or CI validation was performed for this design decision.
