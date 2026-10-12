# Watchdog: isolated by project

Every watchdog finding about workspace X goes to X's orchestrator only: X's sidebar session
(`__home_agent__:X:<selected agent>`) or a headless run in X's project. Never to another project's orchestrator.

## Why

On 2026-10-07 23:09Z, config.json had `orchestrator.wake.target: "kanban-2uge"`, one wake target for the whole
machine. The watchdog typed foo's stall alerts ("6f756: dev card has been in Review 14 min with no QA card ...",
"8d024 ...") into the kanban-2uge sidebar session and asked that orchestrator to fix foo. That breaks the
project-isolation rule ([project-isolation.md](project-isolation.md)): an orchestrator only works on its own project.
Before this change, the watchdog sent the wake home only under `isolation.mode: enforce`. In `off` and `report`, the
target won.

## What it does now

- **No cross-workspace target.** The wake target is always the workspace the items are about
  (`src/pipeline/watchdog/watchdog.ts` `wake()`). `orchestrator.wake.target` still parses, so an old config.json
  keeps its other wake settings, but the parser drops it and nothing reads it. `migrateLegacyConfigKeys()` deletes it.
  `kanban doctor` warns about it (area `home`), and `kanban doctor --fix` and `kanban config import-kit` remove it.
  The legacy kit's `wakeTarget` is no longer imported. `kanban project rename-id` deletes the key too, rather than
  renaming it. After the migration every workspace wakes its own orchestrator (a headless run, or its sidebar
  started server-side), default-kit and landing-off projects included (they get stuck-prompt items and wake
  requests). A project that should only get ATTENTION.md needs `workspaces.<id>.orchestrator.wake.enabled: false`.
- **Leftover queue lines.** Before the upgrade, X's items were appended to the old target's `orchestrator-queue.txt`,
  tagged `[X]`. A headless run now takes only the lines tagged with its own workspace and logs how many others it
  dropped (`keepOwnQueueLines` in `headless-run.ts`). Its follow-up check reads only its own ATTENTION.md, and
  `kanban doctor --fix` for the removed target strips foreign lines from every queue file (`stripForeignQueueLines`).
  `kanban project rename-id` rewrites the `[<id>]` tags of the renamed project's queue, so its queued items survive.
- **Per-workspace routing.** `workspaces.<id>.orchestrator.wake.enabled` and `.mode` override the machine-wide
  `orchestrator.wake.enabled` and `.mode` (null keeps them; `resolveWorkspaceWakeSettings()` in pipeline-config.ts).
  Cooldown, timeout and live-session minutes stay machine-wide.
- **ATTENTION only when X can't be woken.** With X's wakes off, nothing is woken and no other workspace is woken
  instead. Everything that would have woken X's orchestrator is listed in X's own `ATTENTION.md` on every tick
  while it holds: stalls as `- **<id>** (stall): ...` (no triage cooldown, since the file is recomputed each tick),
  and pending `kanban orchestrator wake` requests as `- **wake request** (<condition>): ...`. Those requests stay in
  the request file and wake X once its wakes are on again. When wakes are on and X has no live sidebar, the watchdog
  still starts X's own sidebar session server-side, or a headless run in mode `headless` (user, 2026-10-07: that
  session is X's own orchestrator). A failed start keeps the queued items for the next tick (`wakeRetry`) and never
  falls back to anything else.
- **Per-workspace state.** Wake cooldowns (`woken`), retries (`wakeRetry`), the pending Enter (`wakeEnter`), triage
  cooldowns, resumes, pauses and job times live in `data/<ws>/watchdog-state.json`. Wake requests live in
  `data/<ws>/orchestrator-wake-requests.json`, the headless queue in `data/<ws>/orchestrator-queue.txt`, silent wakes in
  `data/<ws>/orchestrator-inbox.jsonl`, and the
  headless lock in `run/orchestrator-<ws>.lock`. The worker's in-memory "just started" guard is keyed by the session
  id or `headless:<ws>`. Each of these names one workspace, so a pending wake in one project can't block or retarget
  another's. The issue import follows the same rules: its job runs per workspace, `applyIssues` names its own
  workspace (the worker host checks the path), its "N new issue card(s)" wake goes into that workspace's own wake
  request file, and its wake notes ride along only with a wake of that workspace (with its wakes off they stay in
  its issue state).
- **Identity.** Every wake request to the server names X as both `workspaceId` and `fromWorkspaceId`. The field is
  required on `startOrchestratorSession` and on a `deliverInput` into a home-agent session id. The server
  (`src/server/watchdog-actions.ts`) refuses such a request when the field is missing or differs from the target, in
  every isolation mode, and refuses typing into a home-agent session id of another workspace. Card input (recovery,
  the QA gate) names no board and is not affected. A headless run for X gets X's orchestrator session credential, bound
  to the run's pid (`issueOrchestratorCredential` / `bindOrchestratorCredential`), so its `kanban` calls act as X's
  orchestrator. The sidebar session is launched through `startTaskSession`, which gives it X's credential. Under
  `enforce`, wakes go to the sidebar session instead of a headless run, because a headless run has no isolation
  guardrails.
- **The restart wake.** After a server start each workspace's own orchestrator gets one "Kanban restarted" item
  (`watchdog.restartWake`, `src/pipeline/watchdog/restart-wake.ts`) built only from that workspace's restart
  manifest and its own `restart` records in its pipeline-decisions.jsonl, routed like any other wake item (with its
  wakes off, into its own ATTENTION.md). Only workspaces with an orchestrator get one: a sidebar summary in its
  sessions.json or a wake in its watchdog state. "Sent" is `restartWake` in its own watchdog-state.json, keyed by
  the server start.
- **Machine-wide jobs stay machine-wide.** The PID pressure level, its flag files and the process sweep run once
  per tick for the machine, and their notices go to the server log (`watchdog: PID pressure, level ...` and the
  process-sweep lines). A workspace's ATTENTION.md carries a PID-pressure line only because its own new work is
  held, and that line never wakes anyone. Prune-done runs per workspace, on that workspace's board only.

## Silent wakes

User request, 2026-10-12: "is there any way to have kanban message you silently so it doesn't interrupt what I'm
typing". The typed-input hold (issue #35) keeps a wake out of the user's draft, but the wake still lands in the
sidebar as a new prompt as soon as the user pauses. With `orchestrator.wake.delivery` `auto` (the default) or
`silent`, a wake into X's live sidebar can wait for the agent's next prompt instead:

- **Who decides.** The watchdog, per wake (`decideWakeDelivery` in `src/pipeline/watchdog/wake.ts`): silent when the
  sidebar's agent has the prompt hook (`agentTakesSilentNotices`, `src/terminal/orchestrator-agents.ts`: Claude Code
  only) and, in `auto`, the user typed in that sidebar within `quietMin` (`viewerTypedAt`, the same signal the wake
  text reads) and no item is urgent. Urgent items are the ones that need the user or an answer now: a card stuck on a
  prompt or approval, an escalation with cause `outage` or waiting for approval, a card the kit stopped. They are typed
  at once, as before. A headless run, a sidebar the watchdog starts and an agent without the hook are unchanged.
- **The inbox.** The watchdog asks the server (`queueOrchestratorNotices`, refused unless `fromWorkspaceId` and the
  session id name X itself); the server appends one JSON line tagged with X to `data/X/orchestrator-inbox.jsonl`
  (`src/server/orchestrator-inbox.ts`, the file's only writer). If the queue fails, the wake is typed.
- **The hook.** X's Claude sidebar launch gets its own `--settings` file with a second `UserPromptSubmit` hook,
  `kanban hooks orchestrator-notices --workspace-id X`. The workspace comes from the argument, never the env. The hook
  calls tRPC `orchestratorInbox.take` (a workspace procedure, strict caller: only X's orchestrator or the user; the
  hook sends the sidebar's session credential), and prints the notices as `hookSpecificOutput.additionalContext`
  framed "Kanban notices since your last turn: ...", which Claude Code adds to the prompt without showing it in the
  input box (checked with claude 2.1.296). Any failure prints nothing and exits 0, so the prompt is never blocked;
  the notices then stay queued.
- **Nothing waits forever.** Each entry carries `typeAfter` (queued + `quietMin`). A server sweep (every 15 s) takes
  the entries that are due and types them into X's sidebar as one wake through the typed-input hold (never into a
  draft). A Kanban-typed prompt fires the hook too, so it carries whatever else is queued. Entries whose sidebar has
  no process are kept until an hour past `typeAfter`, then dropped with a log line; by then the watchdog has woken
  again for whatever still holds.
- **The badge.** The sidebar's Kanban Agent header shows "N Kanban notices queued" from `orchestratorInbox.status`
  (workspace-scoped, polled every 15 s), never from the project list.
- **Rename.** `kanban project rename-id` rewrites the entries' `workspaceId` and `taskId`, since the server only
  hands out lines tagged with the workspace.

## One worker, not one watchdog process per project

The user offered one watchdog process per project. We kept one watchdog in the pipeline worker, isolated per
workspace, because it is simpler and more robust:

- **The isolation came from routing, not from process boundaries.** The leak was one config key that pointed every
  workspace at one target. State was already per workspace (one file per workspace). A process per project would not
  have stopped a target setting from naming another project. Removing the target, plus the server refusing
  cross-workspace requests, does.
- **Fewer processes under PID pressure.** The pod has hit its `pids.max` (the PID-pressure rules exist because of
  that). N extra Node processes, each with its own IPC channel, snapshot stream and timers, make that worse, and the
  watchdog's own pressure sweep would be split across them.
- **Machine-wide jobs need a single owner.** PID pressure, the flag files and the orphan sweep are machine-wide.
  With a process per project, either every process runs them (duplicate sweeps, flag files racing) or one gets
  elected (a new failure mode).
- **The board-effect rule stays as it is.** Board effects go only through the server's request channel
  (`src/server/watchdog-actions.ts`), which already checks that a request stays inside one workspace. One channel
  means one place to enforce that.
- **Failure containment is already per workspace.** `tick()` catches each workspace's error and goes on with the
  next workspace, and the worker host restarts a crashed worker.

What a process per project would add, and doesn't matter here, is OS-level memory separation between projects
inside the watchdog. The watchdog holds only snapshots the server sends it, and the server is shared anyway.
