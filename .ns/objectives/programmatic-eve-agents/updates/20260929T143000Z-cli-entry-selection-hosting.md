# CLI entry-selection hosting

## Summary

By explicit user request, `eve dev`, `eve build`, and `eve start` can host one `createAgent` entry selected through the internal `EVE_INTERNAL_AGENT_SELECTION` envelope (JSON `{ entry, registration }`, entry relative to the cwd application root). No public CLI flag was added; a public flag would need its own research doc and e2e coverage.

The CLI parses the envelope once (`internal/application/agent-selection-environment.ts`). In entry mode the application context uses the cwd as application and agent root without project discovery, rejects `--agent`, and rejects commands other than dev/build/start. The typed `AgentEntrySelection` flows through the dev child JSON payload, `DevelopmentServerOptions`, `startNitroDevelopmentServer`, `prepareDevelopmentApplicationHost`, and the rebuild coordinator; for builds through `ApplicationBuildOptions`, `buildApplication`, and `prepareProductionApplicationHost`. `CompileAgentResult.entrySelection` records the mode so runtime-module preparation skips instrumentation discovery. Workspace extension discovery/builds are skipped in entry mode. The interactive TUI receives the entry-mode project context instead of rediscovering an agent directory. `eve start` only needed the discovery bypass because production loads bundled artifacts.

`apps/fixtures/embedded-weather-agent` now has `dev`/`build`/`start` scripts that set the envelope.

## Evidence

- `test/scenarios/entry-selection-host.scenario.test.ts`: under `eve dev`, the entry serves its agent info, inline tool, and a custom channel route; an edit to a transitive import of the entry is published; an adjacent throwing `agent/` tree and `instrumentation/` provider are not loaded (reverting the instrumentation bypass fails the test). `eve build` then `eve start` serve the channel route after the authored `src/` tree is removed.
- `agent-selection-environment.test.ts` covers envelope parsing and actionable errors.
- Manual: interactive `eve dev` boots the TUI under a pseudo-terminal (header shows `weather`). Headless `eve dev` on the embedded fixture answered a real-model weather request through the inline tool via `eve remote invoke`, and reloaded an instruction edit; the built fixture started and passed `/eve/v1/health` with `weather-agent.ts` moved away (the eve channel correctly required auth in production).

## Remaining gaps

- Resources (dev-server state, locks, Workflow data, `.output`) are still keyed by application root only, so one app can host only one registration at a time.
- The dev watcher reuses the flat-layout behavior: it watches the whole application root, so edits to unrelated files there also trigger rebuilds.
- Next.js `withEve` entry registration, generated Vercel service commands, and durable-session recovery evidence remain open.
- The workspace-extension skip is not covered by a negative-control test.
