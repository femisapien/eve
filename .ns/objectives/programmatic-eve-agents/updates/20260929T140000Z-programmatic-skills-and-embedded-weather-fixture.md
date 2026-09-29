# Programmatic skills and embedded weather fixture

## Summary

By explicit user request, `createAgent` now accepts `skills`: a keyed map of `defineSkill` or dynamic skill definitions projected to `skills/<key>.ts` entry slots. Skills reuse the module-backed skill compiler; keys use the tool/instruction key grammar. Skill packages with sibling asset/script directories remain deferred.

`apps/fixtures/embedded-weather-agent/weather-agent.ts` reproduces the filesystem `weather-agent` fixture in one `createAgent` file. It type-checks only; hosting remains open. Type-checking it exposed that typed `approval`/`approvalKey` policies did not fit the aggregate `tools` map, so the storage type now erases those callbacks as `stampToolDefinition` does.

## Evidence

- `entry-sources.test.ts` compares an entry skill to the equivalent filesystem module skill.
- `entry-sources.scenario.test.ts` compiles a bundled entry importing `eve/skills` and asserts the compiled skill.
- A one-off local compile of both weather fixtures matched model, options, tools, and skill; only the filesystem instructions' trailing newline differed.
- The subagent capability contract epoch 22 report was regenerated for the changed `createAgent` type.
