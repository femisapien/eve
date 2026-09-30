---
issue: https://github.com/vercel/eve/issues/3022
status: in-progress
last_updated: "2026-09-30"
---

# Sessions across eve upgrades

## The decision

When an eve upgrade leaves a session behind on code that can no longer run it, should the framework
own what happens next? There are three options:

- **A. Status quo, plus documentation.** No framework changes. On Vercel, document that old
  deployments must outlive their sessions so handoff can run. On self-hosted Worlds, document that
  an eve upgrade ends every parked conversation, and describe the ways to avoid that: draining
  sessions first, or a blue/green setup with a second World and a conversation router.
- **B. Detect and reset.** eve recognizes a session it cannot run, ends it cleanly, and starts a
  fresh session for the incoming message. Callers that hold the old session id get a precise error.
  No history is carried over.
- **C. Revive.** B, plus an opt-in way to continue the conversation in a new session seeded from the
  old one's last checkpoint.

This proposal ships B as the default and C as opt-in. B is also the status quo on self-hosted
Worlds, made correct and visible. C is where most of the new concepts and authoring burden come
from, and it can be decided separately.

## Background

### Address and owner

A session has two identities that users usually see as one:

- **Address.** What callers hold: the session id, its continuation aliases (a Slack thread, a
  Linear issue), and its public event stream.
- **Owner.** The Workflow run, and the deployment behind it, that executes the session.

A Workflow run can only be replayed by the exact code that started it. eve's step ids include the
eve version (`eve@0.58.1`), so any eve upgrade, including a patch release, produces code that cannot
replay older runs. Authored code does not affect this: authored step ids are unversioned, so an app
release without an eve upgrade replays cleanly.

### Handoff: how upgrades work today when they work

[Handoff](./single-workflow-session-upgrades.md) moves a session to new code. When a message for an
idle session lands on a newer deployment, the **old owner, still running on its old deployment**,
checkpoints itself and starts a successor on the new one. The address does not change: the session
id and stream stay the same, and the original run stays parked to keep the stream open.

Handoff depends on the old deployment still being able to execute the old owner, which requires a
World that routes each run to the code that started it. Vercel does this, because its deployments
are immutable and each run is pinned to one. `eve dev` does it partially (see [`eve dev`](#eve-dev)).
The local World under `eve start` and Postgres do not.

## Current behavior by backend

What an operator sees after upgrading eve while sessions are parked:

| Backend                                | Old code still runnable?                                                                                | What happens today                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vercel Workflow                        | Yes, while the deployment is retained                                                                   | Handoff. Users notice nothing. If an operator deletes the old deployment, messages to its sessions are accepted and never answered, with no error. The proposal does not change this.                                                                                                                                                                                                     |
| Local world with `eve start`, Postgres | No. One process is replaced in place, and the World has one queue target                                | On startup the World re-enqueues every active run. Each parked session replays on the new eve and fails with `CORRUPTED_EVENT_LOG`, which releases its hooks. The next message to a channel alias silently starts a new, empty session: the bot forgets the conversation. Sends by session id (HTTP, TUI) get `session_not_active`. A turn that was in flight during the upgrade is lost. |
| `eve dev`                              | Authored code yes, per build generation. eve framework code no: every generation runs the installed eve | Within one server, a rebuild starts a new generation, and sessions hand off to it. After a restart without `--resume`, earlier generations' runs are dormant, and messages to them fail with a generic error. With `--resume`, they are recovered and hand off, except across eve versions, where replay fails with `CORRUPTED_EVENT_LOG`.                                                |

So on Vercel, stranding is a rare edge case. On self-hosted Worlds it happens on **every** eve
upgrade, and today it looks like amnesia. #2866 and #3022 are reports of this, and
[#3022](https://github.com/vercel/eve/issues/3022)'s author wrote a lossy transcript replay to work
around it.

## Lexicon

| Term                   | Meaning                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| owner                  | The run and deployment currently executing a session. Existing term.                                                                                                                                                                       |
| handoff                | The old owner moves an idle session to a successor on the new deployment. Cooperative. The address is unchanged. Existing mechanism.                                                                                                       |
| legacy import          | A one-time migration from the pre-handoff driver topology. The session keeps its id. Existing mechanism, and the closest relative of revive.                                                                                               |
| **stranded**           | The owner cannot execute on any available code. The conversation is still stored, but nothing can act on it.                                                                                                                               |
| **reset**              | Existing command: end the session and free its address. New: it works on a stranded session by cancelling the run directly. It is also the default stranded policy, which resets and then starts a fresh session for the incoming message. |
| **revive**             | New command and opt-in policy: read a stranded owner's last checkpoint, start a **new** session seeded from it, then cancel the stranded run. Not cooperative. The address changes.                                                        |
| checkpoint             | The session's last committed durable state (history, authored state, limits, usage, context). Revive reads it from the stranded run's persisted step inputs.                                                                               |
| `$eve.version`         | Run attribute: the eve version that started the owner. Decides whether the current build can replay the owner. Changes every eve release.                                                                                                  |
| `$eve.session_version` | Run attribute: the `DURABLE_SESSION_VERSION` of the owner's checkpoints. Decides whether the current build can read them, and therefore revive. Changes only when the format changes.                                                      |
| spec version           | The Workflow protocol version recorded on each hook. Owners below the runtime's execution floor (spec 6) are stranded on every World.                                                                                                      |

`reason` on a stranded session is either `deployment-unavailable` (the eve version differs on a
single-deployment World) or `world-spec-incompatible`. `checkpoint-unreadable` and
`checkpoint-missing` are not stranding reasons. They are ways a revive attempt can fail.

## Handoff versus revive

|                       | Handoff                                                 | Revive                                                               |
| --------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- |
| Who performs the move | The old owner, on its own deployment                    | The new deployment, reading the old run's records without running it |
| When                  | Only when the session is idle                           | Whenever a message arrives, or on request                            |
| Session id and stream | Unchanged (the original run parks as the stream anchor) | New. `session.revived` links to the old id                           |
| Pending work          | Handoff waits until there is none                       | Interrupted: tool calls, approvals, questions, tasks, subagents      |
| Old run               | Parks or exits normally                                 | Cancelled. Its code never runs again, so it emits no terminal events |
| Backends              | Vercel, and `eve dev` for authored changes              | Any. The main use is self-hosted                                     |
| Failure               | The old owner recovers and processes the message        | Falls back to reset                                                  |

Why revive cannot keep the id: freeing the old run's hooks requires cancelling it, and the session
id is that run's id. After cancellation eve reports the session as `cancelled`, the World assumes
nothing writes to a finished run's stream, and zero-retention runs lose their stream when they
finish. Legacy import keeps the id only because the old driver stays alive as the anchor. A stranded
run cannot do that. Reset starts a new session for the same reason.

## Options

### A. Status quo, plus documentation

Documentation only:

- **Vercel:** keep each deployment longer than its longest session. If Deployment Retention deletes
  one first, its sessions stop answering without an error.
- **Self-hosted:** an eve upgrade ends every parked conversation. Operators can accept that, drain
  or reset sessions before upgrading, or run blue/green. Blue/green here means a second World (for
  example a second database) for the new version, a router that sends each conversation to the stack
  that owns it, and retiring the old stack once it drains. eve provides no such router, so the guide
  would have to explain how to build one.

- **Pros.** No new concepts or public API, and no runtime cost. Chat channels keep working after an
  upgrade, just without memory.
- **Cons.**
  - `CORRUPTED_EVENT_LOG` is the only signal, it looks like a failure, and it points operators at
    the wrong cause.
  - Descendant task, subagent and workflow-tool runs are left to end on their own timeouts.
  - Id-addressed callers get `session_not_active` with no explanation.
  - "Drain before upgrading" is not practical for sessions that last days.

### B. Detect and reset (default)

eve classifies the owner before committing each delivery, so a message is never committed to a
stranded owner. When the owner is stranded:

- **Delivery through a channel alias.** eve resets the session and starts a fresh one with the
  message:
  - cancel the stranded run and the tasks, subagents and workflow-tool runs it tracked;
  - wait for its hooks to be released;
  - start a new session through the ordinary path, which claims the alias.

  eve logs a warning with the old and new eve versions. Concurrent messages to one stranded address
  produce exactly one new session.

- **Send by session id** (HTTP channel, TUI, `Session.send`). The call is refused, because resetting
  silently would leave the caller holding a dead id. `Session.send` throws
  `SessionStrandedError { reason, revivable, owner.eveVersion }`, and the HTTP channel returns
  `409 session_stranded` with a message that names reset (and revive, where it applies). This is the
  only path that refuses.
- **Explicit `reset` and `clear`.** These work on a stranded session, by the same cancel-and-release
  steps.
- **Startup.** A guard stops the World's startup re-enqueue from replaying stranded runs. They stay
  `running` until their next delivery resets them, instead of failing as `CORRUPTED_EVENT_LOG`.

- **Pros.**
  - Chat channels keep working after an upgrade with no authored code, the same as today.
  - The failure is named: every surface gets a precise log line or error instead of a corrupted
    event log.
  - Descendants are cleaned up.
  - Id-addressed callers learn why their session ended and what to do next.
  - No new authored API.
- **Cons.**
  - The conversation is still lost, as it is today.
  - Every delivery costs an extra lookup: `runs.get` on local and Postgres, and `hooks.getByToken` on
    Vercel.
  - Stranded runs that never get another message stay `running` indefinitely (see
    [Open questions](#open-questions)).
  - A deleted Vercel deployment still swallows messages silently. Detecting it needs an external API
    call.
  - Once reset, a run can't be revived or rolled back to the old eve version. We don't consider that
    likely enough to be worth a separate policy value: an operator who needs rollback can pin the eve
    version.

### C. Revive (opt-in)

With `sessions.stranded: "revive"`, a message through a channel alias continues the stranded
conversation in a new session seeded from its checkpoint. Explicit revive (a command,
`POST /sessions/:id/revive`, `/revive` in the TUI) is available under either policy. When the
checkpoint is missing or unreadable, revive falls back to reset, so channel code never sees a
refusal it has to handle.

- **Pros.**
  - Self-hosted eve gets an upgrade path that keeps conversations, which it does not have today.
  - Revive uses the full-fidelity durable history, including tool history, authored state, limits
    and usage, not a text transcript.
  - A pending approval can never be executed without a fresh approval.
  - Channel aliases move to the new session, so a Slack user keeps the same thread.
- **Cons.**
  - It is a new session to anything that tracks sessions by id, so authored hooks have to be reviewed
    (see [What authored code sees](#what-authored-code-sees-after-a-revive)).
  - Pending work is lost, and users re-approve actions and re-authorize connections. Messages the
    stranded run accepted after its last checkpoint are lost until a planned follow-up (I5)
    redelivers them.
  - Callers that hold a session id (HTTP, TUI) have to revive explicitly and switch to the new id.
  - It adds a third migration mechanism (handoff, legacy import, revive), each with its own
    invariants.
  - Revive reads the checkpoint from persisted Workflow step inputs. That relies on two internal
    details: every session step receives the full session state as its input, and Worlds keep step
    inputs for running runs. If either changes, revive breaks, and only tests would catch it.
  - A `DURABLE_SESSION_VERSION` bump makes every older session impossible to revive. It then falls
    back to reset. There is no migration chain.

### Summary

|                                      | A. Status quo                     | B. Detect and reset (default)             | C. Revive (opt-in)                                 |
| ------------------------------------ | --------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| Conversation survives an eve upgrade | No                                | No                                        | Yes, as a new session                              |
| Channel alias after an upgrade       | Fresh session, silently           | Fresh session, logged                     | Seeded session, `session.revived`                  |
| Id-addressed caller after an upgrade | `session_not_active`, no reason   | `409 session_stranded` with the next step | Same as B, plus explicit revive                    |
| Descendant runs                      | Left to end on their own timeouts | Cancelled                                 | Cancelled                                          |
| Authored code must change            | No                                | No                                        | Review `session.started` hooks                     |
| New public surface                   | None                              | Error, 409, `reset` clear result          | Policy value, command, route, event, `revivedFrom` |

## Reset compared with the status quo

On self-hosted Worlds, the default `reset` policy gives users the same result as today: after an
eve upgrade, the next message in a conversation starts a fresh session. What changes is how it
happens:

|                                 | Status quo                                    | `reset`                                            |
| ------------------------------- | --------------------------------------------- | -------------------------------------------------- |
| Stranded run at startup         | Replayed. It fails with `CORRUPTED_EVENT_LOG` | Not replayed. It stays `running`                   |
| Next message on a channel alias | Fresh session                                 | Stranded run cancelled, then a fresh session       |
| Descendant runs                 | Orphaned                                      | Cancelled                                          |
| Id-addressed caller             | `session_not_active`                          | `409 session_stranded` with `reason` and next step |
| Operator signal                 | A failed run with a misleading error          | A warning naming both eve versions                 |

We considered a `"reject"` policy value that would refuse channel deliveries and leave the run
intact for a later decision. We dropped it. It made the default worse than today for chat channels:
every pre-upgrade conversation would throw until someone reset it. And the flexibility it bought
(reviving or rolling back after the upgrade) is not a scenario we expect operators to use.

## `eve dev`

`eve dev` treats each build as a deployment. Every rebuild, whether from the source watcher or a
server restart, creates a generation with its own id and a retained snapshot of the compiled
authored code. The dev World routes each run's deliveries to its own generation's snapshot
(`development-world-client.ts`). Every snapshot resolves the eve package currently installed.

So `eve dev` behaves like Vercel for authored changes: the old code still runs, and a session hands
off to the newest generation. For eve upgrades it behaves like the self-hosted Worlds: the old owner
would replay on new framework code, which fails.

Today, `--resume` decides whether previous generations' runs are recovered at all. Without it they
are dormant, and messages to them fail. Stranding should apply only when recovery is attempted,
since a dormant run is one the developer chose not to recover. That leaves two designs:

- **Keep `--resume`.** Without the flag, runs stay dormant and messages to them are refused. This is
  the one place a refusal survives on a channel path, and the `sessions.stranded` policy (including
  `"revive"`) would not apply in dev without the flag. With the flag, runs of the same eve version
  are recovered and hand off, and runs from another eve version are stranded and follow the policy.
- **Remove `--resume` (recommended).** `eve dev` always recovers previous generations' runs, as the
  local World already does under `eve start`. Runs of the same eve version recover and hand off to
  the new generation. Runs from another eve version are stranded, skipped by the startup guard, and
  reset or revived on their next message. Dormancy goes away as a concept, and dev behaves the way
  production does, which also makes it the place to try `"revive"` before deploying.

Removing `--resume` has a cost. Today's default avoids surprise work on restart: unfinished turns
continue and timers fire. After the change, a restart with the same eve version continues that work.
The startup guard removes the main danger `--resume` warns about, which is replay failing across eve
versions after it has already executed some work. Changing an authored workflow body while a run of
it is in flight can still fail replay, as it can today.

## What authored code sees after a revive

A revived session is a new session that continues a conversation. Anything keyed by the
conversation continues. Anything keyed by the session id sees a new session. (After a reset, the new
session is simply fresh: nothing is carried, and hooks fire as for any new session.)

| Surface                                           | After revive                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Model history, usage, remaining limits            | Carried                                                                                    |
| `defineState` and extension (`eve:mount.*`) state | Carried. `initial()` does not run, and values keep the shape older app code wrote          |
| Initiator auth                                    | Carried. The triggering message's auth is `current`                                        |
| `session.started` hooks and channel handlers      | **Fire again**, after `session.revived`                                                    |
| Dynamic resolvers                                 | Resolve against current code (as they do after handoff)                                    |
| Connection authorization tokens                   | Not carried. Users re-authorize                                                            |
| Sandbox                                           | Not carried. It belongs to the stranded session                                            |
| Pending approvals and questions                   | Interrupted. Their ids are listed in `session.revived`, and late answers authorize nothing |
| Tasks, subagents, workflow-tool runs              | Cancelled. The model learns about it from an interruption record                           |
| Session timeout                                   | Restarts from the configured value                                                         |
| Old session's terminal events and hooks           | **Never fire.** The old run is cancelled without running its code (also true after reset)  |

`session.started` fires again because the successor has a new id. A hook that records "session X
started" would otherwise never learn about the session that every later event refers to. The cost
falls on once-per-conversation side effects, such as a welcome message, a "conversation created"
row, or state reset in a hook, which now run twice. eve cannot tell these apart from per-session
work, so authors guard them:

```ts
async "session.started"(_event, ctx) {
  if (ctx.session.revivedFrom !== undefined) return; // { sessionId, reason, eveVersion? }
  await sendWelcome(ctx.session.id);
}
```

The general guidance: seed state with `defineState(name, initial)` rather than in a hook, guard
per-conversation side effects with `revivedFrom`, and leave per-session consumers alone.

## Proposed authoring API

```ts
// agent.ts
export default defineAgent({
  sessions: {
    stranded: "revive", // default "reset"
    revive: { compact: true }, // optional: compact carried history before the first turn
  },
});
```

- The policy controls deliveries through a channel continuation alias. Sends by session id always
  refuse with `SessionStrandedError` or a 409, whatever the policy.
- Explicit `reset` and `revive` from an authorized caller are allowed under either policy.
- `"revive"` falls back to reset when the checkpoint cannot be read. Only explicit revive reports the
  failure: `revive_failed` at the runtime boundary, `SessionReviveFailedError` from handles, and an
  error response from the HTTP route. In every case the stranded run is left untouched.
- Public handles throw rather than returning new result members. Adding members to
  `SessionSendCommandResult` would break existing channel code.
- `ClearSessionResult` gains `{ status: "reset" }`, because a stranded session cannot clear in
  place.
- `session.revived` is the first event on a revived session's stream:
  `{ previousSessionId, previousEveVersion?, reason, interruptedRequestIds }`.
- `ctx.session.revivedFrom` is available wherever `ctx.session` is.
- HTTP: `409 session_stranded`, plus `POST /sessions/:id/revive`, authorized against the old id.
  It returns the new id.

**Separable:** `from(address).send(message, { history })` exposes a restricted form of the seeding
path (user and assistant text and file parts only) so channel authors can import conversations or
write their own stranding policy (#91). Revive does not need it, and it can be decided on its own.

## Versions

Two run attributes answer two different questions, and neither can stand in for the other:

| Attribute              | Question                                    | Changes                            | Used for     |
| ---------------------- | ------------------------------------------- | ---------------------------------- | ------------ |
| `$eve.version`         | Can this build replay the owner?            | Every eve release                  | Stranding    |
| `$eve.session_version` | Can this build read the owner's checkpoint? | Only on a checkpoint format change | Revivability |

- Classifying by session version would treat an upgrade from 0.58 to 0.60 as runnable and replay the
  run into `CORRUPTED_EVENT_LOG`.
- Deriving revivability from the eve version would need a hand-maintained table mapping eve releases
  to checkpoint versions, which would go stale silently.
- A missing attribute means the run predates the stamp. Such runs count as stranded on
  single-deployment Worlds and as revivable, because every release before the stamp wrote session
  version 1.
- `revivable` is advisory. The revive attempt still validates the checkpoint.
- Handoff has its own `SESSION_CHECKPOINT_VERSION`, and the Workflow spec version is a separate,
  third floor.

## Open questions

1. **Linking a reset session to its predecessor.** A channel can't tell an upgrade reset from a new
   conversation, so it can't tell the user "I lost our earlier context after an upgrade". Options:
   - server log only (the simplest);
   - generalize `revivedFrom` into one field that covers both outcomes, such as
     `ctx.session.strandedFrom { sessionId, reason, eveVersion?, revived: boolean }`;
   - a `session.reset` first event alongside `session.revived`.
2. **Removing `eve dev --resume`.** Is always recovering previous generations acceptable in dev, given
   that unfinished work resumes on restart?
3. **Cleaning up stranded runs.** Runs that never receive another message stay `running`. With
   `reset` as the default, the startup guard could reset them eagerly instead of skipping them, but
   then id-addressed callers would get `session_not_active` rather than an explanation, and startup
   would take on work proportional to the number of stranded runs.
4. **Revive's new-session semantics.** Is continuing as a new session (a new id, with
   `session.started` firing again) acceptable to authors, or does it make revive a feature few will
   turn on?
5. **Depending on persisted step inputs.** Is coupling revive to the persistence of Workflow step
   inputs acceptable, or should eve write its own checkpoint marker?
