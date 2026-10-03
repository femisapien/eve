# eve/extensions/code

`eve/extensions/code` is an eve extension for coding work. It contributes `apply_patch`, `gh`, `grep`, investigation and PR skills, a read-only worker subagent, sandbox tooling, and shared PR-watch primitives. Vercel credentials are brokered before each turn; GitHub credentials are scoped to one repository and leased for each `gh` tool invocation. Because eve workflow directives are application-only, consumers own their `prwatch` / `prwatch_delete` workflow tools.

It ships inside the `eve` package. This private `@eve/code` workspace package is its source of truth: eve's build copies `extension/` into `packages/eve/src/extensions/code/extension` and publishes it with these entry points:

- `eve/extensions/code`: the extension
- `eve/extensions/code/sandbox`: sandbox bootstrap and credential helpers
- `eve/extensions/code/tools`: `apply_patch`, `gh`, and `grep`
- `eve/extensions/code/prwatch`: PR-watch primitives for consumer-owned workflow tools

## Use

User documentation lives in [`docs/code-extension/`](../../docs/code-extension/index.md) and is published at [eve.dev/docs/extensions/code](https://eve.dev/docs/extensions/code). Installed projects can read the same files under `node_modules/eve/docs/code-extension/`.

The guide covers mounting, sandbox preparation, GitHub leases, Vercel credential delivery, worker configuration, and troubleshooting. The [reference](../../docs/code-extension/reference.md) lists configuration, tool contracts, skills, and public exports.

## Develop in this workspace

Rebuild eve after editing `extension/`; the local agent under `agent/` mounts the built `eve/extensions/code`:

```sh
pnpm --filter eve build
pnpm --filter @eve/code typecheck
pnpm --filter @eve/code test
pnpm --filter @eve/code test:scenario
pnpm exec oxlint packages/eve-code
pnpm exec oxfmt --check packages/eve-code
```

Tests live under `test/`, outside the extension distribution. Unit and integration tests run through the workspace's matching test tasks. The package integration task depends only on eve's build. The root integration command runs the framework suite before the other packages because that suite rebuilds the runtime files they import. Scenario tests exercise temporary files, local Git repositories, and subprocesses; they need Node.js 24 or newer, Git, and Bash, but no model or service credentials.

The `typescript-compiler` development alias supplies the JavaScript compiler API used by the diagnostics worker test. The workspace's TypeScript 7 CLI remains the package typechecker.

## Benchmarks

eve-code is benchmarked with [eve-bench](https://github.com/vercel-labs/eve-bench#readme) on the SWE-lean dataset. eve-bench owns datasets, execution, comparisons, and reports; this package keeps no benchmark runner of its own.

### In CI

The `eve-code > Benchmark harness` workflow runs whenever `packages/eve-code/**` changes. It benchmarks the PR head's eve-code, opencode, and pi together, using the model in the `EVE_CODE_BENCH_MODEL` repository variable. Every trial runs in its own Vercel Sandbox, and all of them start at once, so a run takes about as long as its slowest trial. Each harness is compared with its own latest result from `main`. The report covers resolved tasks, latency, and token usage. It goes to the job summary and a PR comment.

Comment `/benchmark` to re-run the default harnesses, or `/benchmark <harness>[,<harness>...]` to choose, for example `/benchmark codex,eve-code`. You need write access to the repository. Every push to `main` that touches eve-code publishes fresh results to the eve-bench result store, which is where later PRs get their baselines.

### Locally

With [eve-bench](https://github.com/vercel-labs/eve-bench#readme) linked (`npm link` in its checkout), commit and push this checkout, then run:

```sh
eve-bench -a eve-code --agent-dir packages/eve-code --model openai/gpt-6-luna --reasoning low \
  --scope <vercel-team> --execution vercel-sandbox
```

Pass several harnesses to compare them in one run, for example `-a eve-code,opencode,pi`. Use `--task <name>` to run a single task. Local runs never publish to the result store.

### Investigating a failed trial

Trial sandboxes are deleted as soon as each trial finishes. Before deletion, eve-bench pulls each trial's logs and traces out of the sandbox and uploads them with the workflow artifact. To read them, point eve-bench at the CI run:

```sh
eve-bench trials logs https://github.com/vercel/eve/actions/runs/<id>
eve-bench trials logs https://github.com/vercel/eve/actions/runs/<id> --harness eve-code --task <task>
```

The report's Diagnostics section prints this command with the run URL filled in. The download uses the GitHub CLI and needs read access to this repository. The raw files (`agent.log`, `events.ndjson`, `observability.ndjson`, `verifier.log`) are cached under `~/.cache/eve-bench/runs/`.
