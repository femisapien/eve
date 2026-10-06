# eve Public Docs

These docs are for building agents with eve. The framework, npm package, and CLI binary are all named `eve`.

## Find the page for your task

| To do this                                               | Read this                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Create a project                                         | [Getting Started](./getting-started.mdx)                                               |
| Understand the file layout                              | [Project Structure](./concepts/project-structure.mdx)                                  |
| Set the model, reasoning, or other agent-wide config     | [Agent Configuration](./agent-config.md)                                               |
| Change what the agent does and how it behaves            | [Instructions](./instructions.mdx)                                                     |
| Give the agent a typed capability it can call            | [Tools](./tools/overview.mdx)                                                          |
| Require approval, or ask the user something mid-turn     | [Human in the Loop](./tools/human-in-the-loop.md)                                      |
| Call an external HTTP API or MCP server                  | [Connections](./connections/overview.mdx)                                              |
| Add a messaging surface (Slack, Discord, iMessage, …)    | [Channels](./channels/overview.mdx)                                                    |
| Expose your own HTTP route as a conversation surface     | [Custom Channels](./channels/custom.mdx)                                               |
| Package a procedure the agent loads only when it applies | [Skills](./skills.mdx)                                                                 |
| Carry state across turns, or shape what the model sees   | [State](./concepts/state.md), [Context Control](./concepts/context-control.md)         |
| Run commands or untrusted code in isolation              | [Sandboxes](./sandbox/index.mdx)                                                       |
| Delegate work to a specialist child agent                | [Subagents](./subagents/index.mdx)                                                     |
| Run work on a recurring schedule                         | [Schedules](./schedules.mdx)                                                           |
| Install an existing integration instead of writing one   | [Add Integrations](./install-integrations.mdx)                                         |
| Build a coding agent, or compare eve-code benchmarks     | [Code Extension](./code-extension.mdx)                                                 |
| Link a Vercel project and deploy to production           | [Deploy to Vercel](./guides/deployment/vercel.mdx)                                     |
| Self-host, or compare hosting strategies                 | [Deployment](./guides/deployment/overview.md)                                          |
| Authorize routes, sessions, and per-user access          | [Authentication](./guides/auth-and-route-protection.md)                                |
| Build a web UI, or stream a session to a client          | [Frontend](./guides/frontend/overview.mdx), [Client SDK](./guides/client/overview.mdx) |
| Test the agent's behavior                                | [Evals](./evals/overview.mdx)                                                          |
| Look up a CLI command or an exported type                | [CLI](./reference/cli.md), [TypeScript API](./reference/typescript-api.md)             |

## Legal and safeguards

eve is in preview; the framework, APIs, documentation, and behavior may change before general availability.

As the deployer, it is your responsibility to ensure your agent complies with applicable laws.

You are responsible for configuring approval policies, tool restrictions, connection scopes, route/session authorization, sandbox controls, telemetry exports, and other safeguards appropriate for your use case.

Before using eve with non-public, sensitive, regulated, or production data, review which default tools, custom tools, MCP tools, shell/file/web tools, connected services, subagents, schedules, and external actions are available to the agent.

Require human approval or other safeguards for sensitive, irreversible, regulated, financial, healthcare, employment, housing, legal, safety-impacting, user-impacting, or external side-effecting actions.

Unless you configure stricter controls, eve agents may operate with permissive settings, including tool execution without human approval where approval is omitted and sandbox network egress that is not deny-all. Do not rely on model behavior alone to prevent sensitive or irreversible actions.

## The public mental model

eve is a filesystem-first framework for durable backend agents.

You author an agent as files on disk:

- instructions in `instructions.md` or `instructions.ts`
- optional procedures in `skills/`
- typed integrations in `tools/`
- external MCP servers in `connections/`
- the per-agent sandbox override in `sandbox/`
- messaging integrations in `channels/`
- shared authored code in `lib/`
- specialist child agents in `subagents/`
- recurring jobs in `schedules/`
- additive runtime config in `agent.ts`

eve then gives you:

- a stable HTTP message route
- optional channel webhook routes
- a reconnectable session stream
- durable session state across turns
- a per-agent sandbox with a shared runtime workspace
- typed runtime helpers accessed through `ctx` (`ctx.session`, `ctx.getSandbox()`)
