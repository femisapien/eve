# Web chat comparison evidence

Seven draft changes split the e0 web port into reviewable outcomes. Each checkout adds one group to the previous branch. Each before capture uses the preceding implementation; each after capture uses that group's implementation. PR 1 compares against d88aedeef375c654a04da7e81bb06e7098478306.

## Fixture and reproduction

- Desktop viewport: 876 × 758 CSS pixels. Mobile: 390 × 844. Light theme. All images are direct browser captures, without annotation or image editing.
- Generate the consumer with `node scripts/preview-web-chat.mjs`, then `pnpm --dir .web-preview install --ignore-scripts` and `pnpm --dir .web-preview dev --port 4314` after building the local eve package. Node 24+ and repository-pinned pnpm are required.
- Replace `.web-preview/agent/agent.ts` with `fixture-agent.ts` and put `fixture-tool.ts` at `.web-preview/agent/tools/inspect_fixture.ts`. The generator supplies the deterministic researcher child. No model provider or external service is called.
- Send `Show details for https://eve.dev with `inline code`.`, `long scroll comparison`, `Follow the latest message` and `Resume the older session` in the first session. Create another titled `Second session for history comparison`, and a third with `Please delegate the fixture check.`
- Keep the same fixture runtime and stored histories for both comparison arms. Only the generated application files change. The late captures include the same additional follow-up messages in both arms; the initial presentation comparison frames the original answer.
- For a pre-PR-3 browser, add the same Symbol.dispose/Symbol.asyncDispose compatibility prerequisite used by the after arm before importing eve. This is an environment prerequisite, not credited as a visual change.
- Mobile measurements require waiting for the resized page to paint before taking a screenshot. Old build-cache directories must live outside the preview tree because Tailwind scans the source tree.

## Source and check boundaries

The captures came from the extracted commits recorded in `capture-sources.json`. Packaging subsequently removed unrelated lockfile/registry formatting changes, replaced unsafe type casts and conditional spreads, and fixed the intermediate PR 5/6 composer fallback when no draft owner is available. Those changes do not alter the local fixture views shown here. Generated templates were regenerated and checked after source changes.

Focused validation in each checkout:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm fmt apps/docs/registry/channel/web apps/docs/registry/channel/web-sign-in-with-vercel
node packages/eve/src/setup/build.ts --check
pnpm lint
pnpm --filter eve exec vitest run --config vitest.integration.config.ts src/setup/scaffold/index.integration.test.ts
```

From PR 3 onward, `pnpm --filter @eve-internal/web-chat test` and `pnpm --filter @eve-internal/web-chat typecheck` validate the cumulative web source. The final checkout also passed `GOMAXPROCS=4 pnpm exec turbo run typecheck --concurrency=1` and `pnpm docs:check`. Default parallel workspace checking hit a shared docs-build ENOTEMPTY race; the serial run passed.

## Remaining review gates

- Visual approval is still pending. The user explicitly requested more polish; these drafts preserve an inspectable comparison rather than claiming the design is final.
- Dark theme screenshots, animation recordings and process-crash/background-task recovery are not included. The port changes rendering and client state; it does not prove durable task recovery across server termination.
- PR 7 needs a deployed test with two actual signed-in Vercel users and the configured metadata database. Its local screenshots prove local-mode compatibility only.
- No full model-backed CI E2E result is claimed. Required CI must pass before merge.
