---
title: "Code Extension"
description: "Mount eve's built-in coding tools, skills, read-only worker, and GitHub and Vercel credential brokering."
url: /extensions/code
---

The code extension gives an eve agent the building blocks for repository work in its sandbox: a patch editing tool, content search, an authenticated GitHub CLI tool, investigation, review, and pull request skills, a read-only worker subagent, and coding instructions. It ships inside the `eve` package as `eve/extensions/code`, so you mount it without installing another package.

The extension does not choose your root agent's model, prepare your sandbox, open a network policy, or author long-running pull request watches. Those stay in your application.

## What the extension adds

Mount names follow the [extension namespace rules](/docs/extensions#mount-it). With a mount at `agent/extensions/code.ts`, the extension contributes:

| Contribution         | Mounted name                                                              | Behavior                                                                                                          |
| -------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Patch tool           | `code__apply_patch`                                                       | Applies a multi-file patch inside a Git checkout, then returns diagnostics introduced by the patch.               |
| Search tool          | `code__grep`                                                              | Searches `/workspace` with ripgrep, or with a POSIX fallback when ripgrep is unavailable.                         |
| GitHub tool          | `code__gh`                                                                | Runs one `gh`, authenticated `git`, or `gh-signed-commit` command with a repository-scoped token.                 |
| Worker subagent      | `code__worker`                                                            | Answers scoped questions with read-only tools in the parent agent's sandbox.                                      |
| Skills               | `code__investigate`, `code__review`, `code__pr`, `code__lookup-agent-run` | Load procedures for diagnosis, deep review, draft pull requests, and Agent Run lookup.                            |
| Instruction fragment | Added to the agent's instructions                                         | Describes autonomous coding work, repository safety, GitHub tool usage, and pull request publication.             |
| Authentication hook  | None                                                                      | Requests a Vercel token before each turn when you configure `vercel`. Without that option, the hook does nothing. |

See the [code extension reference](/docs/extensions/code/reference) for tool inputs, outputs, limits, and helper APIs.

## Before you start

You need:

- An eve agent. See [Getting Started](/docs/getting-started).
- A sandbox where commands can modify `/workspace`. The patch, search, and GitHub tools run in the agent's [sandbox](/docs/sandbox).
- For the `code__gh` tool, a Vercel Connect GitHub connector that can issue app tokens for repositories in one GitHub organization, plus a sandbox provider that supports `setNetworkPolicy()`.
- For Vercel CLI authentication, a Vercel Connect connector that can issue app tokens.

The default eve sandbox image for Vercel and Docker includes the prerequisites used by `installCodeTooling`: Linux, Bash, Node.js and npm, Git, ripgrep, `apt-get`, and passwordless `sudo`. Custom images need the same tools, plus root or noninteractive `sudo`. If `gh` is missing, preparation installs it with `apt-get`.

## Mount the extension

Create `agent/extensions/code.ts`:

```ts title="agent/extensions/code.ts"
import code from "eve/extensions/code";

export default code({});
```

This mount adds `code__apply_patch`, `code__grep`, `code__worker`, the skills, and the instruction fragment. It also adds `code__gh`, but that tool fails until you configure `github`.

The instruction fragment is additive and cannot be replaced through an extension override. Use your agent's own [instructions](/docs/instructions) to add project-specific constraints.

## Prepare the sandbox

Install the CLI wrappers and diagnostics in the sandbox environment's `prepare` callback:

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { installCodeTooling } from "eve/extensions/code/sandbox";

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installCodeTooling(sandbox);
  },
});

export default defineSandbox(() => environment.open());
```

`installCodeTooling` installs:

- `gh`, when it is missing
- a `gh` wrapper and `gh-signed-commit`
- an isolated TypeScript compiler used by `code__apply_patch` diagnostics

Pass `{ vercel: true }` to also install the Vercel CLI and `vercel` and `vc` wrappers. Without that option, preparation does not install the Vercel CLI.

eve reuses a prepared environment until the sandbox file or environment options change. Changes in imported helper code do not invalidate it, so an eve upgrade that changes the code tooling does not rebuild an existing environment by itself. Change `agent/sandbox.ts` to prepare a new environment.

## Configure GitHub access

Configure `github` to enable the `code__gh` tool:

```ts title="agent/lib/network-policy.ts"
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import type { GitHubLeaseRule } from "eve/extensions/code/sandbox";

// Add every host your agent's commands need between GitHub commands.
export const baseAllow = {
  "api.github.com": [],
  "github.com": [],
  "registry.npmjs.org": [],
};

type NetworkPolicySandbox = SandboxSession & {
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
};

function hasNetworkPolicy(sandbox: SandboxSession): sandbox is NetworkPolicySandbox {
  return "setNetworkPolicy" in sandbox;
}

export async function setGitHubLeasePolicy(
  sandbox: SandboxSession,
  rules: Readonly<Record<string, readonly GitHubLeaseRule[]>> | null,
): Promise<void> {
  if (!hasNetworkPolicy(sandbox)) {
    throw new Error("The code__gh tool requires a sandbox with setNetworkPolicy().");
  }
  const policy = { allow: { ...baseAllow, ...rules } };
  await sandbox.setNetworkPolicy(policy as SandboxNetworkPolicy);
}
```

```ts title="agent/extensions/code.ts"
import code from "eve/extensions/code";

import { setGitHubLeasePolicy } from "../lib/network-policy";

export default code({
  github: {
    connector: "github/acme-bot",
    org: "acme",
    broker: setGitHubLeasePolicy,
  },
});
```

Open the sandbox with the same base policy:

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { installCodeTooling } from "eve/extensions/code/sandbox";

import { baseAllow } from "./lib/network-policy";

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installCodeTooling(sandbox);
  },
});

export default defineSandbox(() => environment.open({ networkPolicy: { allow: baseAllow } }));
```

Replace `github/acme-bot` with your connector UID and `acme` with the GitHub organization. Each `code__gh` call follows this sequence:

1. The model declares exactly one repository in that organization with `write` access.
2. eve validates the command and its explicit repository targets.
3. eve requests an app token from Vercel Connect for that repository only.
4. eve calls your broker with header-transform rules for `github.com` and `api.github.com`.
5. The command runs with a placeholder token. The firewall exchanges the placeholder on matching GitHub requests.
6. eve calls your broker with `null` so it can remove the lease.

Your broker owns the complete live network policy. Preserve any hosts your agent needs, add the supplied rules while the lease exists, and remove them when `rules` is `null`. eve serializes leases for one session and redacts the token from command output.

Valid `code__gh` commands run without a human approval prompt. eve denies invalid input, such as shell syntax, more than one declared repository, or a command that explicitly targets an undeclared repository. To require approval for every GitHub command, override the tool:

```ts title="agent/extensions/code/extension.ts"
import code from "eve/extensions/code";

import { setGitHubLeasePolicy } from "../../lib/network-policy";

export default code({
  github: {
    connector: "github/acme-bot",
    org: "acme",
    broker: setGitHubLeasePolicy,
  },
});
```

```ts title="agent/extensions/code/tools/gh.ts"
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { gh } from "eve/extensions/code/tools";

export default defineTool({ ...gh, approval: always() });
```

Use a directory mount for this override. Remove `agent/extensions/code.ts` when you create `agent/extensions/code/extension.ts`. See [Override a contribution](/docs/extensions#override-a-contribution) for precedence and removal.

## Configure Vercel CLI access

Configure `vercel` when the agent should run Vercel CLI commands. Prepare the sandbox with `installCodeTooling(sandbox, { vercel: true })`, then add the connector:

```ts title="agent/extensions/code.ts"
import code from "eve/extensions/code";

export default code({
  vercel: { connector: "vercel/acme-bot" },
});
```

Before each turn, the extension requests an app token from Vercel Connect. The default delivery, `firewall`, keeps the token outside sandbox processes:

- Without a top-level `broker`, eve replaces the live network policy with one that allows every host and injects the token for `api.vercel.com` and `vercel.com`. This requires `setNetworkPolicy()`.
- With a top-level `broker(sandbox, rules)`, eve calls your callback instead. `rules` maps each Vercel host to the headers to inject; convert those headers into your provider's network policy and preserve your other rules.

Use `delivery: "command"` for providers without mutable network policy:

```ts title="agent/extensions/code.ts"
import code from "eve/extensions/code";

export default code({
  vercel: { connector: "vercel/acme-bot", delivery: "command" },
});
```

Command delivery writes `VERCEL_TOKEN` to `/workspace/.eve-code/env` with mode `600`. The `vercel` and `vc` wrappers read that file. Sandbox processes that can read the file can read the token.

A failed Vercel token request is logged by the hook. It does not cancel the turn, so later Vercel CLI commands fail authentication.

### Use GitHub and Vercel together

The GitHub broker and Vercel firewall delivery both update the same live network policy. eve does not pass a session identifier to either callback, so do not combine their rules through module-level state: an eve process can serve multiple sessions.

When you configure both, use Vercel command delivery and add the Vercel hosts to `baseAllow`:

```ts title="agent/lib/network-policy.ts"
export const baseAllow = {
  "api.github.com": [],
  "api.vercel.com": [],
  "github.com": [],
  "registry.npmjs.org": [],
  "vercel.com": [],
};
```

```ts title="agent/extensions/code.ts"
import code from "eve/extensions/code";

import { setGitHubLeasePolicy } from "../lib/network-policy";

export default code({
  github: {
    connector: "github/acme-bot",
    org: "acme",
    broker: setGitHubLeasePolicy,
  },
  vercel: { connector: "vercel/acme-bot", delivery: "command" },
});
```

## Configure the worker subagent

`code__worker` shares the parent sandbox, disables eve's default tools, and enables only `glob`, `grep`, and `read_file`. It cannot write files, load skills, or use web tools. By default, it uses `openai/gpt-5.6-terra-fast` with `xhigh` reasoning.

Set both `model` and `reasoning` to choose another model:

```ts title="agent/extensions/code.ts"
import code from "eve/extensions/code";

export default code({
  worker: {
    model: "openai/gpt-6-luna",
    reasoning: "high",
    openaiReasoningEffort: "max",
  },
});
```

`openaiReasoningEffort` is optional. eve passes it to OpenAI models as `providerOptions.openai.reasoningEffort`.

## Use credentials without Vercel Connect

`authenticateGitHub` and `authenticateVercel` broker credentials from another source for commands you run through ordinary sandbox tools:

```ts title="agent/sandbox.ts"
import { defineSandbox } from "eve/sandbox";
import { VercelSandbox } from "eve/sandbox/vercel";
import { authenticateGitHub, installCodeTooling } from "eve/extensions/code/sandbox";

export const environment = VercelSandbox.environment({
  prepare: async (sandbox) => {
    await installCodeTooling(sandbox);
  },
});

export default defineSandbox(async () => {
  const sandbox = await environment.open();
  await authenticateGitHub(sandbox, { token: process.env.GITHUB_TOKEN! });
  return sandbox;
});
```

Set `GITHUB_TOKEN` in the app runtime environment. These helpers do not configure the `code__gh` tool. Because the extension's instructions direct authenticated GitHub work to that tool, tell the model in your own instructions when it should use ordinary `gh` commands instead.

## Watch pull requests from application tools

`eve/extensions/code/prwatch` exports snapshot, notification, and registry primitives. The extension does not mount watch tools. Author those tools and their scheduling in your application, and configure `github` because snapshot reads use the mounted extension's GitHub connector. Snapshots include the pull request state, head commit, and the review owner's latest review for that head; they do not include CI checks.

## Use computer use separately

Computer use is the separate `eve/computer-use` extension. Mount it next to the code extension when your sandbox has a desktop. The computer-use exports from `eve/extensions/code/sandbox` and `eve/extensions/code/tools` are deprecated.

## Troubleshooting

| Symptom                                                   | Check                                                                 | Next action                                                                                                                                                                      |
| --------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GitHub command access is not configured for this agent.` | The mount passes no `github` option.                                  | Configure `github.connector`, `github.org`, and `github.broker`.                                                                                                                 |
| Vercel CLI commands fail authentication                   | Search Vercel runtime logs for the authentication hook error.         | For `connector installation is required`, install or attach the connector to the Vercel project. For a mutable network policy error, pass `broker` or set `delivery: "command"`. |
| `code__gh` reports a Connect token error                  | Confirm the connector UID, organization, and repository installation. | Install the GitHub connector for the declared repository, or declare a repository the connector can access.                                                                      |
| `eve-code tooling installation failed`                    | Read the command output in the error.                                 | Install `gh` at `/usr/bin/gh`, provide `apt-get`, or run preparation with root or noninteractive `sudo`.                                                                         |
| `code__apply_patch` returns no TypeScript diagnostics     | Confirm that `installCodeTooling` ran in the prepared environment.    | Add it to `prepare`, then change `agent/sandbox.ts` to prepare a new environment.                                                                                                |
| `code__gh` denies a command                               | Read the denial reason.                                               | Use simple argv syntax, declare one repository in the configured organization, and make explicit `-R` or `--repo` targets match it.                                              |

## What to read next

- [Code extension reference](/docs/extensions/code/reference): configuration, tool contracts, and exports
- [Extensions](/docs/extensions): mount, configure, and override extensions
- [Sandbox](/docs/sandbox): environment preparation and network policy
- [Connections](/docs/connections): Vercel Connect setup and connector UIDs
