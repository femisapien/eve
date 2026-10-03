---
title: "Code Extension Reference"
description: "Configuration, tool contracts, skills, and public exports for eve/extensions/code."
url: /extensions/code/reference
---

This page lists the public contract of the code extension. For setup, start with [Code Extension](/docs/extensions/code).

## Import paths

| Import                        | Exports                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `eve/extensions/code`         | Default mount factory; `CredentialPolicyBroker`, `GitHubLeaseBroker`, and `GitHubLeaseRule` types |
| `eve/extensions/code/tools`   | `apply_patch`, `gh`, `grep`; deprecated `computer_use`                                            |
| `eve/extensions/code/sandbox` | Sandbox tooling, credential, and GitHub command helpers; deprecated computer-use helpers          |
| `eve/extensions/code/prwatch` | Pull request watch schemas, snapshots, notification transitions, and registry helpers             |

Mount names below assume `agent/extensions/code.ts`. Another mount filename changes the `code__` prefix.

## Configuration

`code(config)` validates this object when the mount loads. Every top-level field is optional.

| Field                          | Type                                                                                  | Default                     | Behavior                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| `github.connector`             | non-empty `string`                                                                    | None                        | Vercel Connect connector used by `code__gh` and pull request snapshots.                      |
| `github.org`                   | non-empty `string`                                                                    | None                        | GitHub organization that owns every declared repository.                                     |
| `github.broker`                | `GitHubLeaseBroker`                                                                   | None                        | Applies GitHub lease rules, then receives `null` after each command. Required with `github`. |
| `vercel.connector`             | non-empty `string`                                                                    | None                        | Vercel Connect connector used by the before-turn authentication hook.                        |
| `vercel.delivery`              | `"firewall" \| "command"`                                                             | `"firewall"`                | Delivers the Vercel token through network-policy headers or a sandbox environment file.      |
| `broker`                       | `CredentialPolicyBroker`                                                              | None                        | Replaces the built-in Vercel firewall policy update.                                         |
| `worker.model`                 | non-empty `string`                                                                    | `openai/gpt-5.6-terra-fast` | Model for `code__worker`. Required with `worker`.                                            |
| `worker.reasoning`             | `"provider-default" \| "none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"` | `"xhigh"`                   | Worker reasoning. Required with `worker`.                                                    |
| `worker.openaiReasoningEffort` | `"none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"`              | None                        | Passed to OpenAI models as `providerOptions.openai.reasoningEffort`.                         |

Callback signatures:

```ts
import type { SandboxSession } from "eve/sandbox";
import type { GitHubLeaseRule } from "eve/extensions/code";

type CredentialPolicyBroker = (
  sandbox: SandboxSession,
  rules: Record<string, Record<string, string>>,
) => Promise<void>;

type GitHubLeaseBroker = (
  sandbox: SandboxSession,
  rules: Readonly<Record<string, readonly GitHubLeaseRule[]>> | null,
) => Promise<void>;
```

`CredentialPolicyBroker` receives a host-to-headers map. `GitHubLeaseBroker` receives network-policy rules keyed by host, or `null` to remove the lease.

## Tools

### `code__apply_patch`

Applies authored edits inside one Git checkout. The tool uses `never()` approval.

| Input       | Type     | Constraints                                                                                              |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `root`      | `string` | Absolute Git work tree root inside the sandbox workspace. It must equal `git rev-parse --show-toplevel`. |
| `patchText` | `string` | Complete patch, up to 500,000 characters.                                                                |

Patch format:

```text
*** Begin Patch
*** Add File: path/to/new.ts
+export const value = 1;
*** Update File: path/to/existing.ts
@@
-old line
+new line
*** Delete File: path/to/old.ts
*** End Patch
```

An update can include `*** Move to: new/path.ts`. Paths are relative to `root` and cannot escape it. A patch can contain at most 100 file operations, and two operations cannot target the same path.

The tool rejects patches that target package-manager lockfiles, `dist/`, `.next/`, `.eve/`, `coverage/`, `vendor-compiled/`, or `node_modules/`. Regenerate those files with the command that owns them.

eve parses and verifies the entire patch before writing. It checks again before each write and rolls back earlier writes when a later write fails. It serializes patches for the same session and repository.

The output contains `files` and `diagnostics`. Each file has `operation` (`add`, `delete`, `move`, or `update`), `path`, and `previousPath` for moves. Diagnostics use these checks:

| Check        | Applies to                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| `git-diff`   | `git diff --check` for changed and deleted paths                                                       |
| `whitespace` | Added and moved files                                                                                  |
| `syntax`     | `.js`, `.cjs`, `.mjs`, `.ts`, `.mts`, `.cts`, `.json`, `.sh`, `.bash`, and `.py` when `python3` exists |
| `typescript` | `.ts`, `.tsx`, `.mts`, and `.cts` when `installCodeTooling` installed the diagnostics worker           |

TypeScript diagnostics present before an update are filtered out. Without the diagnostics worker, the TypeScript check returns nothing.

### `code__grep`

Searches sandbox content under `/workspace`.

| Input        | Type                                           | Default                | Behavior                                                              |
| ------------ | ---------------------------------------------- | ---------------------- | --------------------------------------------------------------------- |
| `pattern`    | `string`                                       | Required               | Regex or literal pattern.                                             |
| `path`       | `string`                                       | `/workspace`           | Directory or file under `/workspace`. `..` is rejected.               |
| `glob`       | `string`                                       | None                   | File filter, such as `*.ts` or `*.{ts,tsx}`.                          |
| `outputMode` | `"files_with_matches" \| "content" \| "count"` | `"files_with_matches"` | File list, matching lines, or per-file counts.                        |
| `context`    | non-negative integer                           | `0`                    | Context lines for `content` mode.                                     |
| `ignoreCase` | `boolean`                                      | `false`                | Case-insensitive search.                                              |
| `literal`    | `boolean`                                      | Inferred               | Patterns without regex metacharacters default to fixed-string search. |
| `limit`      | integer from 1 to 200                          | `50`                   | Maximum rows returned.                                                |

The output contains `content`, `matchCount`, `outputMode`, `path`, and `truncated`. Returned content is limited to 64 KiB, and each line to 8 KiB. Ripgrep respects `.gitignore`; the POSIX fallback does not. Both include hidden files and exclude `.git`.

### `code__gh`

Runs one authenticated GitHub command. It requires `github` configuration and `installCodeTooling`.

| Input              | Type     | Constraints                                                                                |
| ------------------ | -------- | ------------------------------------------------------------------------------------------ |
| `command`          | `string` | 1 to 20,000 characters. Simple argv quoting only.                                          |
| `permissions`      | array    | Exactly one `{ provider: "github", repositories: ["owner/name"], access: "write" }` entry. |
| `description`      | `string` | 1 to 500 characters describing the intended GitHub-side result.                            |
| `workingDirectory` | `string` | Directory inside the sandbox workspace. Defaults to `/workspace`.                          |

Supported commands:

- `gh <subcommand> ...`
- `git fetch`, `git ls-remote`, `git pull`, or `git push` against `origin`, run from a Git work tree root
- `gh-signed-commit --repo owner/name --branch <branch> -m <headline>`, run from a Git work tree root

The declared repository must belong to `github.org`. Explicit `-R`, `--repo`, `--repo=`, or `gh repo clone`, `view`, and `fork` repository arguments must match the declaration. Authenticated `git` commands must use a canonical GitHub `origin`. Environment assignments, pipes, redirects, substitutions, and shell operators are rejected.

The approval function denies invalid input and requires no approval for valid input. The output contains `exitCode`, `stdout`, `stderr`, and `truncated`. Each stream keeps its final 100,000 bytes after redaction.

`gh-signed-commit` commits staged changes through GitHub so repositories that require verified signatures accept the commit. It accepts `--base` and `-b`, refuses unstaged tracked changes, and synchronizes the checkout to the signed remote commit.

## Worker subagent

`code__worker` uses the parent agent's sandbox through `defineParentSandbox()`. It sets `defaultTools: false`; enables `glob`, `read_file`, and a local `grep` tool with the same behavior as `code__grep`; and disables `load_skill`, `web_fetch`, `web_search`, and `write_file`.

The worker can answer once or keep ownership of a scoped slice across follow-up messages. Its instructions require evidence and prohibit workspace edits and external side effects.

## Skills

| Mounted skill            | Use                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `code__investigate`      | Diagnose a specific issue from reproduction and evidence before proposing a fix.                         |
| `code__review`           | Delegate a security and correctness audit to the worker, then verify its findings.                       |
| `code__pr`               | Rebase or replay the intended diff, create a signed commit when required, and open a draft pull request. |
| `code__lookup-agent-run` | Resolve an eve Agent Run using an Agent Run API, observability connection, or other access you provide.  |

`code__lookup-agent-run` does not provide observability access. Without an authorized source, it reports the missing capability.

## Sandbox exports

### `installCodeTooling`

```ts
import type { SandboxSession } from "eve/sandbox";

declare function installCodeTooling(
  sandbox: Pick<SandboxSession, "resolvePath" | "run" | "writeTextFile">,
  options?: { readonly vercel?: boolean },
): Promise<void>;
```

Installs `gh` with `apt-get` when needed, the `gh` and `gh-signed-commit` wrappers, and TypeScript for patch diagnostics. With `{ vercel: true }`, it also installs `vercel@latest` and the `vercel` and `vc` wrappers. It throws `eve-code tooling installation failed (exit <code>): <detail>` when installation fails.

### `CODE_TOOLING_REVALIDATION_KEY`

A string that changes when the code extension's installed tooling changes. eve does not read it. A prepared environment changes when the sandbox file or environment options change.

### Credential helpers

```ts
import type { SandboxSession } from "eve/sandbox";

interface BrokeredCredentialOptions {
  readonly token: string;
  readonly delivery?: "firewall" | "command";
  readonly broker?: (
    sandbox: SandboxSession,
    rules: Record<string, Record<string, string>>,
  ) => Promise<void>;
}
```

| Helper               | Firewall delivery                                              | Command delivery                                                                         |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `authenticateGitHub` | Injects `Authorization` for `github.com` and `api.github.com`. | Configures a global Git HTTP header and writes `GH_TOKEN` to `/workspace/.eve-code/env`. |
| `authenticateVercel` | Injects `Authorization` for `vercel.com` and `api.vercel.com`. | Writes `VERCEL_TOKEN` to `/workspace/.eve-code/env`.                                     |

Firewall delivery uses `broker` when supplied. Otherwise it requires `setNetworkPolicy()` and replaces the live policy with one that allows every host and adds the credential headers. The helpers do not configure `code__gh`.

### GitHub command helpers

`executeGitHubShell(input, config, dependencies)` and `githubShellApproval(input)` contain the validation and lease logic used by `code__gh`. Use them when you author a replacement tool with different presentation or policy. `GitHubShellInput`, `GitHubShellOutput`, and `GitHubLeaseRule` describe their data.

### Deprecated computer-use exports

`installComputerUse`, `startComputerUse`, and `COMPUTER_USE_REVALIDATION_KEY` remain exported from `eve/extensions/code/sandbox`; `computer_use` remains exported from `eve/extensions/code/tools`. Import from `eve/computer-use/sandbox` and `eve/computer-use/tools`, and mount `eve/computer-use` instead.

## Pull request watch exports

These primitives support application-authored watch tools. The extension does not mount watch tools or schedule polling.

| Group         | Exports                                                                                                                                                                                                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input schemas | `PullRequestWatchInputSchema`, `PrwatchDeleteInputSchema`, `PullRequestWatchInput`, `PrwatchDeleteInput`                                                                                                                                                                                        |
| Snapshots     | `readPullRequestWatchSnapshot`, `pullRequestWatchSnapshot`, `PullRequestWatchSnapshot`, `repoFullName`                                                                                                                                                                                          |
| Notifications | `initialPullRequestWatchNotificationState`, `advancePullRequestWatchNotification`, `framePullRequestWatchWake`, `PullRequestWatchWakeReason`                                                                                                                                                    |
| Errors        | `isRetryablePullRequestWatchError`, `shouldRefreshPullRequestWatchToken`                                                                                                                                                                                                                        |
| Registry      | `registerActivePrwatch`, `prwatchWasCancelled`, `finishPrwatch`, `deletePrwatch`, `prwatchKey`, `emptyPrwatchRegistry`, `registerPrwatchInState`, `isPrwatchCancelledInState`, `cancelPrwatchInState`, `completePrwatchInState`, `PrwatchRegistration`, `PrwatchRegistryState`, `PrwatchTarget` |

`PullRequestWatchInputSchema` accepts `repo` (`owner/name`), a positive `pullRequestNumber`, `reviewOwner`, and a 40-character `redHeadOid`. It lowercases the repository and commit ID.

`readPullRequestWatchSnapshot(input)` uses `github.connector` to request an app token for the repository in `github.org`. It reads the pull request and up to 2,000 reviews, and refreshes the token once after a `401`. The snapshot contains `state` (`open`, `closed`, or `merged`), `url`, `headOid`, and the review owner's latest review state and submission time for the current head. It does not read CI checks.

`advancePullRequestWatchNotification` returns a new state and a wake reason:

| Wake reason            | Condition                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `head_changed`         | The head differs from the previous snapshot, or from `redHeadOid` on the first snapshot.      |
| `owner_review_changed` | The review owner's latest review for the head changed after the first snapshot.               |
| `red_head_stalled`     | The head stayed on `redHeadOid` for `staleAfterPolls` consecutive snapshots. This fires once. |

`registerActivePrwatch`, `prwatchWasCancelled`, `finishPrwatch`, and `deletePrwatch` read or update eve session state. Call them from eve-managed runtime code, such as a tool's `execute` function. The functions ending in `InState`, plus `emptyPrwatchRegistry` and `prwatchKey`, are pure helpers.
