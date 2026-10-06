---
"eve": patch
---

Every request a turn makes of a person now goes through one runtime path: tool approvals, tool authorizations, the session budget question, and questions or approvals relayed from child sessions, remote agents, workflow `ctx.ask()`, and the `ask_question` tool.

- **Approvals:** the turn waits on them. eve runs approved calls itself, with the tools of the step that asked, and re-checks each approval first. History no longer contains the AI SDK's approval parts. A call that waits stays out of history until its approval resolves. A typed reply answers the open approvals it matches, and the rest keep waiting. An answer to an approval whose tool defines an `approval.response` policy becomes a candidate, and the approval settles once the policy allows it, including after the responder authorizes.
- **Authorizations:** a call that needs an authorization holds its turn until the callback arrives. The model then calls it again as the person who started it.
- **Budget question:** the prompt holds the turn open (`turn.waiting` with `on: "input"`) instead of completing it. Approve runs the held model call in the same turn. Stop answers the prompt and cancels the turn, and cancelling the turn withdraws the prompt. A message that doesn't answer the prompt is received into the held turn and read after Approve. A late answer to a prompt that already closed is dropped instead of reaching the model as text.
- **Relayed requests:** the session asks at the child's coordinates, holds the turn on the call that asked, and forwards each answer to whoever asked. A typed reply answers the only relayed question waiting. When a run ends, is cancelled, or withdraws its question, the session withdraws what that run asked. A relayed budget Stop cancels the parent turn too.

**Vercel deployments:** a session whose turn is waiting on a person stays on its current deployment, as before. A deployment on this release doesn't take over a session with requests parked by an earlier release.

**Self-hosted upgrades:** answer or cancel pending approvals, sign-ins, and budget questions before upgrading a self-hosted service. Runs resume on this release, but pending work and queued input from an earlier release aren't supported: an answer to an open request isn't applied, and that work may be requested again or need to be started again. Messages queued behind those requests aren't delivered. See "Upgrading self-hosted sessions that wait on a person" in the execution model docs.
