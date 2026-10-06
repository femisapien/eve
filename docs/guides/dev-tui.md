---
title: "Terminal UI"
description: "Use eve locally or connect to a deployed agent from an interactive terminal UI."
---

`eve dev` starts a local development server and opens an interactive terminal UI. Use it to talk to your agent, approve tool calls, answer its questions, and configure local development. When `eve dev` starts a local server, self-modification is available by default; see [Self-Modification](./self-modification).

```bash
eve dev
```

The footer shows the active model, reasoning level when set, speed indicator, and connection separated by dots, such as `gpt-6-luna · high · ⚡︎`. The model label omits the provider prefix and removes `-fast` only at the end. A single `⚡︎` marks a model with that suffix or explicit **Fast** mode; terminals without Unicode support use an ASCII marker.

The transcript remains in your terminal scrollback after you exit. Run `/help` for available commands.

## Commands

| Command     | Description                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/model`    | Choose the model, speed, and reasoning. Pass a model ID to set it directly: `/model provider/model-id`.                                                      |
| `/new`      | Start a fresh session and clear the screen. `/reset` is an alias.                                                                                            |
| `/clear`    | Clear the session's model-message history and keep the session.                                                                                              |
| `/compact`  | Compact the current session's context.                                                                                                                       |
| `/cancel`   | Cancel the current turn without discarding settled context.                                                                                                  |
| `/login`    | Connect a ChatGPT subscription, Vercel account, or provider API key.                                                                                         |
| `/add`      | Select and install channels, MCP connections, extensions, and observability integrations. Pass an item address to install it directly: `/add channel/slack`. |
| `/deploy`   | Deploy the agent to Vercel production. Installs the Vercel CLI, signs in, and links the directory if needed.                                                 |
| `/traces`   | Open the local trace viewer. Pass a trace ID prefix to open a specific trace.                                                                                |
| `/loglevel` | Choose which server and agent logs appear in the transcript.                                                                                                 |
| `/info`     | Show the resolved application, compiled artifacts, discovery diagnostics, and messaging routes.                                                              |
| `/help`     | List available commands.                                                                                                                                     |
| `/exit`     | Quit the UI.                                                                                                                                                 |

`/login`, `/model`, `/add`, `/deploy`, `/info`, and `/traces` are available when `eve dev` runs locally. They are unavailable when the UI connects through `eve remote connect`.

## Set up a new agent

After interactive `eve init`, the TUI opens directly. eve keeps the project's selected connection. For a new connection, it checks explicit environment credentials, the saved machine default, and then the Vercel CLI's current team. Existing project OIDC connections remain supported. Automatic Vercel reuse validates account access without creating or linking a project.

You can type while eve connects. Press `Enter` to queue the message until the agent is ready. If a picker opens, your draft returns when it closes; failed or cancelled setup restores queued messages to the draft.

If no connection is ready, `/login` offers:

1. Vercel Account
2. Vercel AI Gateway API Key
3. ChatGPT Subscription
4. OpenAI API Key
5. Anthropic API Key

Vercel account login opens a browser. When multiple teams are available, `/login` shows a searchable team picker with the current project or CLI team highlighted so you can switch teams. A sole available team is selected automatically. Automatic startup reuses the selected connection without opening this picker. Account-token access to Gateway depends on availability for your account and team; if it is unavailable, choose an API key or another connection.

Type to filter a menu, press `Enter` to select, or `Esc` to return to chat. Dismissing a setup menu adds no cancellation message to the transcript; completed work and failures still appear. Arrow navigation is also available. Cancelling login preserves your draft. If a connection fails, retry `/login`; eve does not silently switch providers.

### Credentials and deployment

eve saves API keys and eve-owned OAuth refresh credentials in the OS secret store through just-secrets. It saves the last successful login as the machine default and records the project's connection and team separately as nonsecret metadata in `.eve/provider.json`. Newly entered keys are never written into project files. A key explicitly selected through `/login` takes precedence over another key for that provider in your shell; a project connected through environment credentials continues to use its environment. Vercel CLI retains ownership of its credentials and refresh tokens.

Local discovery runs only in development. Deployments need explicitly provisioned `AI_GATEWAY_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or supported project OIDC credentials. ChatGPT subscription models are local-only. `/login` does not link a deployment or authenticate a remote server; `/deploy` handles Vercel CLI installation and account login when needed.

### Models and settings

`/model` walks through model, speed, and reasoning in order:

1. Choose a model. Type to filter the list.
2. Choose **Standard** or **Fast** speed, when supported.
3. Choose a reasoning level, when the model supports reasoning settings. **Provider default** leaves the reasoning level to the provider.

The picker highlights your current settings when they are compatible with the selected model and skips settings that cannot be changed. Use `↑` and `↓` to move, then `Enter` to advance or apply the final choice. `Esc` or `←` returns to the previous step; at the model list, either key cancels. `Ctrl+C` cancels from any step.

Changes apply together after the final choice and take effect on the next prompt. Cancelling leaves settings unchanged.

Gateway connections default to `openai/gpt-6-luna-fast`; OpenAI and ChatGPT default to `gpt-6-luna-fast`; Anthropic defaults to `claude-sonnet-5`. An explicitly authored compatible model stays selected. If a new default is unavailable, eve offers the connection's available models. Dynamic or custom model expressions must be edited in `agent.ts`.

## Add an integration

`/add` opens one searchable catalog of channels, connections, extensions, and integrations. Type to filter and press `Enter` to install one item and run its required setup. The flow returns to chat afterward.

Pass an item address to install it directly:

```text
/add channel/slack
/add extension/agent-browser
/add channel/linear
/add @acme/analytics
```

Required authorization or deployment setup still runs for the selected item. Press `Esc` to cancel setup; files already installed remain in the project. If dependency installation fails, retry the `eve add` command in a terminal for details; raw installer output is not captured in the TUI.

## Work with the agent

Type a message and press `Enter` to send it. When the agent asks a question or requests tool approval, respond in the prompt shown by the UI. Each answer is sent as soon as you give it. When several requests are open, the prompt shows its place among them, such as `2 of 5`, and names the task that asked as its transcript lines do. Connection authorization can open a browser; keep local `eve dev` running until the browser returns to it.

The activity line shows **Thinking** while the model reasons or waits to respond, **Generating** while it writes a response or tool input, and **Running** while tools execute. A blinking dot and elapsed time indicate progress, with token counts shown when available. While [tasks](../tools/tasks) work, the drawer header replaces this line: it shows the parent's current activity, task count, and turn elapsed time without token counts. **Waiting** means the parent is waiting on work; **Working** appears without a turn timer when tasks remain active between turns.

A tool call shows the tool's own `label`, or eve's copy for built-in tools such as `Read README.md`. Any other call shows a readable tool name without its extension or connection prefix, such as `List issues` for `linear__list_issues`. Approval prompts show the exact tool name unless the tool provides a title.

A task, such as a subagent call, writes a transcript line when it starts and another when it finishes, fails, or stops. The finished line includes elapsed time and, for a subagent, a summary such as `Read 3 files, Ran 2 commands`. Task starts use the same styling as synchronous tool calls.

While tasks work, the activity drawer above the prompt shows each task's name, activity, and elapsed time without repeating its launch prompt. Subagents have readable labels, such as `subagent(stock price)` for `stock-price` or `subagent(worker)` for the code extension's `code__worker`. The latest observed tool stays visible beneath each subagent between calls. Background work started by a followed subagent appears beneath it; deeper work uses an ownership path rather than further indentation.

During questions and approvals, activity stays visible above the request when space permits; the request takes priority on small terminals. The drawer caps its height and prioritizes tasks needing approval when work overflows. It does not show the model's own `task_wait` and `task_cancel` calls; their effects appear as the **Waiting** header and a stopped task's transcript line.

The prompt stays open while the agent works, including turns started elsewhere, such as a scheduled run. While a turn is running, `Enter` sends your message immediately as steering. Before assistant output begins, the runtime interrupts pending model generation and continues the same turn with your correction. Executing tools finish safely. After output begins, steering applies at the next workflow boundary and preserves streamed text.

Slash commands run immediately, even during a turn. Press `Esc` or `Ctrl+C`, or run `/cancel`, to cancel a running turn. If you cancel before the turn has started, eve waits for that turn's ID before sending cancellation, so the request cannot cancel a later turn. If a cancellation does not settle, press `Ctrl+C` again to stop waiting: eve starts a new session, and the next `Ctrl+C` exits. At an idle prompt, press `Ctrl+C` twice to exit.

| Key           | Action                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `Enter`       | Send the current message or answer.                                                                        |
| `Shift+Enter` | Insert a newline. Requires a terminal that reports modified keys.                                          |
| `Esc`         | Cancel a running turn.                                                                                     |
| `Ctrl+C`      | Cancel a running turn; press again to stop waiting and start a new session; press twice to exit when idle. |
| `↑` / `↓`     | Move through input lines or sent-message history.                                                          |
| `Ctrl+L`      | Cycle log display modes.                                                                                   |
| `Ctrl+R`      | Redraw the screen.                                                                                         |

## Logs and traces

By default, the UI shows severity-tagged errors. Use `/loglevel <none|error|warn|debug|all>` to change the display; bare `/loglevel` reports the current setting. `warn` adds warnings, `debug` adds all severity-tagged records, and `all` also shows unclassified stdout, stderr, and sandbox output. `none` hides logs. Errors render red, warnings yellow, and unclassified stderr neutral. `Ctrl+L` cycles the same modes. These modes filter received records; they do not change `EVE_LOG_LEVEL` or enable a dependency's debug logging.

Workflow SDK output, such as lines tagged `[workflow-sdk]` or `[world-local]`, reports internal runtime details, so the transcript shows it only in `all` mode.

Every `eve dev` process writes diagnostic logs to `.eve/logs/`, regardless of the display mode. Read them with [`eve logs`](../reference/cli#eve-logs).

Use `/traces` to inspect traces recorded during local development. See [Local traces](../observability/otel#local-traces) for trace capture and retention settings.

## Display options

Use `eve dev` flags to control tool calls, reasoning, subagents, connection authorization, response statistics, context usage, and logs:

```bash
eve dev --tools full --reasoning collapsed --logs all
```

`--subagents` accepts `collapsed` (the default), `full`, or `hidden`. `full` also writes each subagent message and tool call to the transcript as it finishes, and `hidden` leaves subagent tasks out of the transcript and the task panel.

Use `--host` and `--port` to bind the local server, or `--no-ui` to run without the terminal UI. Set `EVE_TUI_RENDER_MARKDOWN=0` to show assistant and subagent responses without Markdown parsing or styling; `1` (the default) enables Markdown rendering. See the [`eve dev` CLI reference](../reference/cli#eve-dev) for the complete option list, accepted values, and defaults.

## Connect to a deployment

Pass a URL to use the terminal UI with an existing eve server instead of starting one locally:

```bash
eve remote connect --url https://your-app.vercel.app
```

For Basic auth, include credentials in the URL. For other schemes, pass `-H, --header` (repeatable):

```bash
eve remote connect --url https://user:pass@your-app.example.com
eve remote connect --url https://your-app.example.com -H 'Authorization: Bearer your_token_here'
```

Remote Vercel sessions reuse an existing authorized CLI session. They do not open an account login flow or modify the local project's Vercel link or `.env.local`.

When Deployment Protection blocks startup, eve verifies the target project and asks before adding a Trusted Sources rule for development access to that deployment's environment. After approval, eve applies the rule and checks access again before returning to chat. Cancelling preserves your draft; restart `eve remote connect --url <url>` to try again. If you cannot change the project's policy, provide `VERCEL_AUTOMATION_BYPASS_SECRET` or ask a project administrator to configure access in Deployment Protection settings.

## What to read next

- [Instrumentation](../observability/instrumentation): traces, OpenTelemetry, and diagnostics.
- [CLI](../reference/cli): commands and flags.
- [Agent Client Protocol (ACP)](../protocols/acp): drive the same agent from ACP clients such as Zed instead of the TUI.
