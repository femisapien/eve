---
"eve": patch
---

`slackChannel` accepts an `api` option, `{ apiBaseUrl?, fileBaseUrl?, fetch? }`, for pointing a channel at a Slack-compatible API instead of `https://slack.com/api/`, matching the option `discordChannel`, `telegramChannel` and `githubChannel` already expose. Omit `api` and nothing changes.

`SlackHandle.request`, `SlackWorkspaceHandle.request` and `callSlackApi`'s `body` take `object` rather than `unknown`. A primitive body no longer compiles, and an array is now encoded field by field where it was sent as an empty body.
