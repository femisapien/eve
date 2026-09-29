# Embedded weather agent

The [`weather-agent`](../weather-agent) fixture authored as one programmatic
`createAgent` definition instead of an `agent/` directory.
[`weather-agent.ts`](./weather-agent.ts) holds the same model configuration,
instructions, `get_weather` tool, and `get-weather` skill.

| Filesystem fixture            | Embedded definition     |
| ----------------------------- | ----------------------- |
| `agent/agent.ts`              | top-level config fields |
| `agent/instructions.md`       | `instructions` string   |
| `agent/tools/get_weather.ts`  | `tools.get_weather`     |
| `agent/skills/get-weather.md` | `skills["get-weather"]` |

## Running

The CLI has no public flag for programmatic entries yet. The package scripts
select this module through the internal `EVE_INTERNAL_AGENT_SELECTION`
environment variable, a JSON object with the entry path (relative to this
directory) and the registration name:

```sh
pnpm --filter embedded-weather-agent dev     # eve dev
pnpm --filter embedded-weather-agent build   # eve build
pnpm --filter embedded-weather-agent start   # eve start
pnpm --filter embedded-weather-agent typecheck
```

While the variable is set, eve compiles only `weather-agent.ts`. It does not
discover `agent/`, extensions, or instrumentation in this directory, and it
supports only `eve dev`, `eve build`, and `eve start`. Next.js `withEve` cannot
select an entry yet.
