---
title: "Self-Modification"
description: "Ask your agent to update its own instructions, tools, skills, and other authored files during local development."
---

Local `eve dev` mounts the self-modification extension by default. Ask the agent to edit files under `agent/`; it delegates the work to `self-modification__agent`. The extension is not included in production builds or added to servers reached through `eve remote connect`.

```bash
eve dev
```

For example, ask the agent to add a reusable action:

```text
Add a tool that converts temperatures between Celsius and Fahrenheit.
```

Review and test the resulting diff. `eve dev` reloads the changed files.

## Change the self-modification model

The subagent uses your agent's model by default. To give it a different model or reasoning level, ask for it directly:

```text
Switch the self-modification subagent to openai/gpt-6-sol with low reasoning.
```

The first time, this creates `agent/extensions/self-modification/extension.ts` with those settings. After that file exists, later changes edit it. You can also edit the file yourself: it accepts `model` and `reasoning` options.

## Run without self-modification

Pass `--no-default-extensions` when you do not want `eve dev` to mount bundled development extensions:

```bash
eve dev --no-default-extensions
```

This disables the complete bundled default set for that server, including self-modification. It does not remove files from your project or disable extensions that you have explicitly mounted under `agent/extensions/`.

## What to read next

- [Terminal UI](./dev-tui): work with your agent locally.
- [Instructions](../instructions): define the agent's behavior.
- [Tools](../tools): add model-callable actions.
- [Skills](../skills): give the agent reusable procedures.
