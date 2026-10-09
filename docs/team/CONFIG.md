# Core settings (config.json)

Every team-workflow setting is a key in Kanban's own `config.json` in the Kanban home, next to the keys Kanban
already had (`selectedAgentId`, `commitPromptTemplate`, …). Two schemas cover them:

- **Core settings** (`src/config/pipeline-config.ts`, zod): the mechanics, machine-wide or per workspace. They never
  name an agent or a model for a card.
- **The kit schema** ([KITS.md](KITS.md)): routing policy. A workspace only says which kit it uses
  (`workspaces.<id>.kit`).

`kanban config show [--workspace <id>]` prints the resolved settings with their defaults. `kanban kit show
--project <id>` prints the resolved kit. Each top-level section, and each workspace entry, is validated on its own.
A section that doesn't validate falls back to its defaults with an issue (shown by `kanban config show` and
`kanban doctor`), so one typo doesn't reset everything else. A workspace entry that doesn't validate is treated as
landing `off` on the `default` kit, which is the safe direction.

Commands that write config.json (`kanban kit apply`, `kanban project add`, `kanban config import-kit`, `kanban
doctor --fix`) change only the keys they own, under the config lock, and refuse an edit that wouldn't validate.

## The Kanban home

`src/state/kanban-home.ts` is the only code that knows paths. A test fails on a home path anywhere else in `src/`
or `web-ui/src/`.

| Order | Home |
|---|---|
| 1 | `kanban --home <dir>` (exported as `KANBAN_HOME` to child processes) |
| 2 | `KANBAN_HOME` |
| 3 | `~/.kanban` of the user running Kanban (root or node) |

Nothing else: Kanban never switches to another directory because it exists, and keeps nothing in `~/.cline` (that
is the Cline CLI's). A path Kanban needs and can't find is an error that says where it looked.

- Task worktrees: `KANBAN_WORKTREES`, else `worktreesRoot` in config.json, else `<home>/worktrees`.
- `legacyWorktreeRoots` (default: none) are searched read-only for worktrees created before a home move, only when
  config.json lists them. Live worktrees are never moved; remove the entry once its worktrees are gone. `kanban
  doctor` warns while an entry exists, and about any Kanban home, board, state file or task worktree under `~/.cline`.
- Per-workspace data: `<home>/data/<workspace>/` (`pipeline-state.json`, `pipeline-decisions.jsonl`, `qa-log.md`,
  `qa-artifacts/`, `ATTENTION.md`, `watchdog-state.json`, `watchdog-decisions.jsonl`, `dev-assignment.jsonl`,
  `restart-manifest.json`, `runoffs.json`, `scoreboard.jsonl`, `calibration/`).
- Logs: `<home>/logs/`. Board backups: `<home>/backups/boards/<workspace>/`. Locks and markers: `<home>/run/`.
  User kits: `<home>/kits/`.

The legacy kit (`~/.kanban` while it is still a git repo, or `KANBAN_KIT_HOME`; its config `KIT_CONFIG`) is only
read: by `kanban doctor`'s one-owner check, `kanban config import-kit`, the first load of each workspace's
`pipeline-state.json` (which imports its `checks-state.json`), card metrics (its board backups and price table), and
the shadow diff (its autoland log). Kanban never writes it.

## Per workspace: `workspaces.<id>`

A workspace without an entry gets every default below: landing `off` on the `default` kit, the same as upstream.
Nothing is inherited from another workspace.

| Key | Default | What |
|---|---|---|
| `name` | null (the repo directory name) | display name |
| `defaultBaseRef` | null (detected) | the branch cards land on; a card's own `baseRef` wins |
| `landing.mode` | `off` | `off`: the orchestrator or the user lands. `commit` / `pr`: upstream auto-review (the agent commits or opens a PR). `qa`: the pipeline QA-gates the card and Kanban squash-lands it before Done |
| `pipeline.shadow` | `false` | decide and log everything, act on nothing (decision log `shadow`), not even dev assignment. The cutover's shadow day uses it |
| `checks.enabled` | null | scripted checks on each submitted snapshot. null = on only with landing `qa` on a kit other than `default` |
| `checks.scripts` | `typecheck`, `lint`, `test`, `build` | the project's npm scripts to run (missing ones are skipped) |
| `recovery.enabled` | `true` | recovery (nudges, outage holds, restart resumes) for this workspace, once `pipeline.recovery.mode` is `on` |
| `kit` | null (= `default`) | `{ name, overrides }`; overrides are dotted kit keys ([KITS.md](KITS.md)) |
| `guardrails.enabled` | null (= `guardrails.enabled`) | task-card guardrails for this workspace |
| `guardrails.extraDenyCommands`, `.extraWritableDirs` | `[]` | added to the machine-wide lists; a workspace can only tighten them |
| `isolation.mode` | null (= `isolation.mode`) | project isolation for this workspace: `off`, `report`, `enforce` ([project-isolation.md](../fork/project-isolation.md)) |
| `isolation.messages` | `deny` | `allow` lets this project's orchestrator send and receive orchestrator messages; both projects must allow |
| `issues.mode` | `off` | issue import ([WORKFLOW.md §14](WORKFLOW.md)): `off` fetches nothing; `report` fetches and logs what it would import (decision log, stage `issues`), creates nothing; `on` imports matching issues as Backlog cards and wakes the orchestrator |
| `issues.provider` | `github` | the tracker (only GitHub today) |
| `issues.repo` | null (from `origin`) | `owner/name`. Must be one of the project's own git remotes (ssh or https form); anything else is refused |
| `issues.pollMin` | `15` | how often the worker's sync job runs |
| `issues.filter.trustedAssociations` | `OWNER`, `MEMBER`, `COLLABORATOR` | authors (GitHub author_association) whose issues are imported |
| `issues.filter.trustLabels` | `kanban` | an issue with one of these labels is imported whoever opened it (applying a label needs triage rights) |
| `issues.filter.includeLabels` | `[]` | when set, an issue must also carry one of them |
| `issues.filter.excludeLabels` | `[]` | an issue with one of them is never imported |
| `issues.planLabel` | `needs-plan` | an issue with this label becomes a plan card when the kit has the plan role |
| `issues.commentOnLand` | `false` | comment on the issue when its card is landed or discarded (landing `qa`; needs a token with write access) |

**Why the issue filter is strict by default.** An issue's text becomes an agent prompt, and anyone can open an issue
or comment on a public repository. So only the repository's own people (OWNER, MEMBER, COLLABORATOR) are trusted,
and an outsider's issue gets in only when someone with triage rights labels it `kanban`. The same
`trustedAssociations` check applies to every comment: an untrusted user's comment never reaches the prompt, only a
line saying how many were left out. An untrusted author's later edits to the title or description are never copied
(GitHub doesn't say who edited, and the label may predate the edit), only noted, and once the trust label is removed
nothing more is added. The card title is `Issue #N: <short title>` (one line, plain characters, at most 72) for a
trusted author and just `Issue #N` otherwise, because the title also reaches the QA prompt's intro, the QA card's
title and the landing commit subject, which are not fenced. Widen `trustedAssociations` (e.g. `CONTRIBUTOR`) only on
a repository whose contributors you'd let write card prompts.

The worker's sync job runs in the watchdog's job runner, so it needs `watchdog.mode: on`; `kanban issues sync` works
without it (the user or the project's orchestrator runs it; card sessions are refused, since it uses the user's
token). Auth: the `gh` CLI's login (`gh auth token`; it also returns a `GH_TOKEN` from the env, such as the
container's PAT), else `GITHUB_TOKEN` / `GH_TOKEN` from Kanban's env, else anonymous (public repositories, 60
requests/h, and every anonymous request counts, 304s included; only authenticated 304s are free). Kanban never writes a
token to a file or a log. State: `data/<ws>/issues-state.json` and `issues-http-cache.json`.

The first sync pins the repository in `issues-state.json`. Task worktrees share `.git/config`, so a card could point
`origin` elsewhere: a derived repository that no longer matches the pin is refused (doctor FAIL) until the user sets
`issues.repo`. An `issues-state.json` that can't be parsed is never overwritten (it holds the records that keep Done
and pruned cards deduped): it is copied to `issues-state.json.corrupt` and issue import stops (doctor FAIL) until the
file is fixed or removed.

## `pipeline.*`

The pipeline worker re-reads config.json on every evaluation. The server re-reads it on every sweep (30 s), so
switching a workspace to landing `qa` starts the worker without a Kanban restart.

| Key | Default | What |
|---|---|---|
| `paused` | `false` | stops the worker for landing and recovery (the watchdog still runs if `watchdog.mode` is not `off`) |
| `workerEntry` | null | another build's `dist/cli.js` for the worker (the dev pod's "fix it live" loop); the host runs `<entry> pipeline worker` |
| `qa.slots` | 2 | QA cards running at once, machine-wide |
| `qa.timeoutMin` | 60 | a running QA card's slot is freed after this |
| `qa.maxNudges` | 2 | nudges for a missing or invalid `verdict.json` before STALLED |
| `qa.verdictGraceSec` | 20 | wait for `verdict.json` after the QA card stops (8495ed2) |
| `qa.checksWaitMin` | 20 | how long a new QA card waits for the scripted checks of its snapshot; after that QA starts with "checks timed out" in its prompt |
| `qa.scratchRoot` | `/tmp/kanban-qa` | QA's scratch copies |
| `qa.outboxRoot` | `/tmp/kanban-qa-out` | `<outbox>/<qa id>/verdict.json` plus artifacts |
| `qa.chromiumLibs` | null | extra libs for headless Chromium (null = the image's) |
| `qa.previewIdleMin` | 5 | stop a preview the QA gate started after this many idle minutes |
| `checks.scratchRoot` | `/tmp/kanban-checks` | snapshot exports for scripted checks |
| `checks.timeoutMin` | 15 | per check run; killed as a process group |
| `checks.allowScripts` | esbuild, prisma, @prisma/engines, @prisma/client, sqlite3 | packages whose install scripts may run in the checks install |
| `checks.maxWorkers` | 2 | cap for test runners in checks |
| `checks.niceness` | 10 | `nice` level of every check step |
| `rework.maxFailRounds` | 3 | the hard cap: the core escalates at this many FAIL rounds whatever the kit says |
| `rework.clearAfterTurns` | 100 | clear the session (and resend the whole prompt) before a rework past this many turns |
| `rework.clearAfterTokens` | 150000 | … or a last input past this many tokens (only Cline sessions are measured) |
| `recovery.mode` | `report` | `off` / `report` (decide and log on landing-`qa` workspaces, act on nothing) / `on` (act, except on shadow workspaces, also on landing `off`/`commit`/`pr` workspaces with `recovery.enabled`). Stays `report` while the legacy autoland runs |
| `recovery.maxNudges` | 2 | crash nudges since the newest verdict before escalating |
| `recovery.maxContinues` | 8 | premature-stop continues |
| `recovery.retryBackoffMin` | `[1, 2, 4, 8]` | provider-error retries, outside the nudge budget |
| `recovery.hungMin`, `.hungFirstMin` | 15, 30 | cancel a request with no writes for this long (first call on Lemonade: 30) |
| `recovery.resumeGapSec` | 20 | restart recovery resumes orphans one at a time, this far apart |
| `recovery.nudgeCheckSec` | 120 | after a nudge, how long the agent gets before the card is decided on again |
| `recovery.stallNudgeMin` | 8 | a running Cline card whose session file shows no progress this long (a silent stall: a tool call with no result, a reply with no STATUS line, or no reply) gets a nudge, counted in `maxNudges`, then escalates. Each further nudge needs another `stallNudgeMin` of silence after the previous one, a hook counts as progress, a pending question to the user is no stall, and a `run_commands` call whose command still runs (a process the agent started, in the card's worktree) is never nudged, however long it takes. 8 clears normal long steps: the longest tool call in foo's session files (3,378 calls, 10/07) took 195 s (`team_await_runs`, its teammates writing meanwhile, which counts as progress), and `run_commands` returns after about 32 s. A session file still `running` with no reply is the hung check's (`hungMin`) |
| `recovery.outage.probeEveryMin` | 5 | outage hold: probe the model this often |
| `recovery.outage.upsToResume` | 2 | good probes in a row to resume |
| `recovery.outage.maxMin` | 360 | escalate after this long |

## `sessionSync.*`

Read once at server start, for the server and the browser alike ([docs/fork/session-sync.md](../fork/session-sync.md)).

| Key | Default | What |
|---|---|---|
| `enabled` | `true` | the server moves cards In Progress ↔ Review on session state changes. `false` brings back the browser's upstream moves. P2-1's top-level `"sessionSync": false` still reads the same; `kanban doctor --fix` rewrites it |
| `reviewSettleSec` | 12 | the review settle rule: code that treats Review as a finished turn acts only once the session has been in Review this long with no state change or hook activity. `0` = off. The column move itself is immediate |

The settle rule applies to the pipeline's snapshot and QA queue, QA ingest, PASS landing, the rework loop's
"returned" check, recovery's Review nudges and auto-review's commit prompt, all through `isReviewSettled()`
(`src/terminal/review-settle.ts`). Why: in Copilot `--autopilot` every continuation flips the card to Review for
about 100 ms, and a background shell can start a new turn about 6 s after the final stop. So QA snapshotted
half-done work, and auto-review typed into a working agent.

## `watchdog.*` and `orchestrator.*`

The watchdog runs in the pipeline worker. With `watchdog.mode` not `off`, the worker runs and gets every workspace.

| Key | Default | What |
|---|---|---|
| `watchdog.mode` | `off` | `off` / `report` (decisions to `data/<ws>/watchdog-decisions.jsonl` only: no ATTENTION.md, no wake, no input, no prune) / `on`. `kanban doctor` fails `on` while the legacy review-watch runs |
| `watchdog.intervalSec` | 60 | tick |
| `watchdog.triageCards` | `false` | TRIAGE cards (on the selected agent) instead of orchestrator wakes |
| `watchdog.triageCooldownMin` | 120 | |
| `watchdog.stall.reviewMin` | 10 | Review with no QA card |
| `watchdog.stall.qaMin` | 45 | QA card running too long (not calibration cards) |
| `watchdog.stall.idleMin` | 30 | In Progress with a dead session |
| `watchdog.stall.resumeIdleMin` | 5 | … gets one LLM-free continue after this, before a wake |
| `watchdog.stall.newCardGraceMin` | 10 | a new Backlog card is not "pipeline idle" |
| `watchdog.stall.promptMin` | 3 | a card stuck on a trust, startup or permission prompt (every workspace) |
| `watchdog.stall.restartGraceMin` | 1 | after a Kanban restart, how long the automatic fixes get before the watchdog reports that they didn't happen: a Review card whose dead QA card the QA gate has not superseded (counted from the start, or from when its QA card was first seen gone) or not replaced (from the supersede), and a card still held for the restart (orphan mark; plus `recovery.resumeGapSec` per marked dev card). A replacement waiting for a QA slot or PID pressure is only logged. Replaces the generic Review stall for that card |
| `watchdog.pids.pressure`, `.brownout` | 0.75, 0.9 | share of `pids.max`: hold new work / Esc running agents once |
| `watchdog.pruneDone.enabled`, `.days` | `true`, 3 | hourly: delete Done cards older than this, after a backup (keeps undecided runoffs and running calibrations) |
| `orchestrator.wake.enabled` | `true` | wake the orchestrator for ATTENTION items |
| `orchestrator.wake.mode` | `headless` | `headless` (a `claude -p` / `codex exec` run; falls back to `sidebar` when the selected agent has no headless runner) or `sidebar` |
| `orchestrator.wake.target` | removed | ignored; `kanban doctor --fix` deletes it. Each workspace wakes only its own orchestrator ([watchdog-isolation.md](../fork/watchdog-isolation.md)) |
| `workspaces.<id>.orchestrator.wake.enabled`, `.mode` | null | this workspace's override of `orchestrator.wake.enabled` / `.mode`. With wakes off its items stay in its own ATTENTION.md (stalls and pending `kanban orchestrator wake` requests listed every tick) |
| `orchestrator.wake.cooldownMin` | 30 | per item |
| `orchestrator.wake.timeoutMin` | 45 | a headless run |
| `orchestrator.wake.liveSessionMin` | 10 | an interactive session active this recently holds a headless run |

There is no `orchestrator.agent`: the orchestrator is always the agent selected in Kanban settings, in the sidebar
session `__home_agent__:<ws>:<selected agent>` of the workspace the items are about, never another workspace's.

## `models.*`, `agents.*`, `backups.*`, `processes.*`

| Key | Default | What |
|---|---|---|
| `models.providers.default` | `bedrock` | the provider for Cline models |
| `models.providers.fallback` | `{}` | model id → provider, for models proven not to work on the default |
| `models.providers.deprecated` | `{}` | documented workarounds `kanban models providers --cleanup` removes |
| `models.providerCapacity.<id>.maxLoadedModels` | `lemonade: 1` | recovery's retries, nudges and resumes and the QA gate's QA card starts wait while another In Progress card holds a different model on that provider; `kanban bench calibrate` refuses a spec that would run more at once (merged over the default) |
| `models.bedrockRegion` | `us-west-2` | probes |
| `models.lists.lemonade.url`, `.requireLabels` | `http://localhost:13305`, `["tool-calling"]` | the model-lists route `GET /api/model-lists/lemonade` (read on every request) |
| `agents.pretrust` | `true` | pre-trust every workspace's main repo root for Claude Code and Codex |
| `agents.cline.dataDir` | null (`~/.cline/data`) | Cline's sessions and providers |
| `agents.cline.turnDetector.mode` | `report` | Cline CLI turn-end detector and session sync's idle-TUI check: `off` / `report` / `on`. `report` while the legacy column-sync logic is still the reference |
| `agents.cline.turnDetector.intervalSec` | 15 | |
| `agents.codex.home` | null (`$CODEX_HOME`, else `~/.codex`) | |
| `backups.board.enabled`, `.everyMin`, `.keep` | `true`, 10, 200 | every board write writes `board-latest.json`, plus a timestamped copy at most every `everyMin` |
| `processes.reaper.enabled`, `.intervalSec`, `.mode` | `true`, 300, `terminate` | the orphan-process sweep (read on every sweep; anything unclear means `report`) |

## `projects.*`

Where Kanban projects live (`src/projects/project-roots.ts`). A project that is created (New project, `kanban
project create`), cloned (Clone from URL) or opened for the first time (Open folder, `kanban project add`) must be
strictly inside one of the roots, never a root itself. The check resolves the path the way the OS will: the realpath
of its deepest existing ancestor, so a symlink pointing out of the root is refused, and a path with `..` is refused
outright. The server is the one check; the browser's Add Project dialog only pre-validates (its directory field
starts with the root as a read-only prefix, and its "does it exist" typeahead answers only for one name directly
under a root).

| Key | Default | What |
|---|---|---|
| `projects.roots` | null = `$KANBAN_PROJECTS_ROOTS` (path-list separated), else `["/projects"]` in a container (`/run/.containerenv` or `/.dockerenv`), else `[<home>]` | the allowed parent roots, first one is the dialog's default; `~` is expanded. Roots that don't exist are skipped |

In the container `/projects` is the projects volume, and `/root` holds config, the Kanban home and task worktrees.
Task worktrees are not projects and never go through this check. Projects registered before the rule (or outside a
narrowed root) are not removed and keep working; `kanban doctor` shows a warn row for each.

## `guardrails.*`

Task-card guardrails (`src/guardrails/`). They are resolved for every launch in `runtimeApi.startTaskSession`, and
each agent adapter applies them with its CLI's own mechanism (`src/terminal/agent-guardrails.ts`). The orchestrator
(the sidebar session and its headless wakes) gets none; under `isolation.mode` `enforce` it gets only the isolation
denies (`isolation.*` below).

| Key | Default | What |
|---|---|---|
| `enabled` | `true` | |
| `confineWrites` | `true` | keep a card's writes in its worktree (plus temp dirs, its git dir and the agent's own data) where the CLI can enforce it |
| `extraWritableDirs` | `[]` | |
| `sharedBranches` | `main`, `master` | plus the card's base branch |
| `denyCommands` | any `git push`; `git filter-branch`/`filter-repo`; `update-ref`, `branch -D/-d/-f/-m/-M`, `switch -C`, `checkout -B` on a shared branch; `podman`/`docker` `restart|stop|rm|kill`; `systemctl [--user] restart|stop|kill`; `kanban home migrate` | card-local rebases and resets stay allowed |

Per agent:

| Agent | Mechanism |
|---|---|
| Claude Code | `permissions.deny` in a per-card `--settings` file |
| Codex | `forbidden` execpolicy rules in `<worktree>/.codex/rules/` (they hold under the sandbox bypass). The `workspace-write` sandbox only where Codex's sandbox can run (not in the rootless pod) |
| Cline | `kanban hooks cline-guard` in Kanban's PreToolUse hook. A `cancel` stops the tool and ends the turn (the card goes to Review) |
| Copilot | `--deny-tool shell(…)` and `write(<dir>/**)`. It keeps `--allow-all-paths` (and `--allow-all-urls`): in autonomous mode Copilot runs with `--autopilot` (a trial since 2026-10-07), which blocks on an "Enable autopilot mode" dialog unless tools, paths and URLs are all allowed |

Whatever a CLI can't enforce goes into a short note in the launch prompt. `kanban doctor` shows one row per
installed agent.

## `isolation.*`

Project isolation (`src/isolation/`, [project-isolation.md](../fork/project-isolation.md)): every agent session,
the orchestrator included, works only on its own project.

| Key | Default | What |
|---|---|---|
| `mode` | `off` | `off`: nothing changes. `report`: reaches outside a session's project are logged to `data/<ws>/isolation.jsonl`, nothing is refused. `enforce`: the runtime API and the Kanban CLI refuse them, launches get the isolation denies, orchestrator wakes stay in the board's own workspace and go to the sidebar session |

A reach between two workspaces follows the stricter of their modes. Whatever the mode, agent sessions can't
create, register or remove projects. The user's escape hatch is `kanban isolation grant` (in-memory, logged on both
sides), which waits for a one-time code printed only on the server's console (`kanban isolation approve <id> <code>`).
Under `enforce` the user's own project add/create/remove waits for one too. Mode changes are logged (`mode_changed`).
Before rolling back to a build without project isolation, remove the `isolation` keys: older builds reject them.

## From kit.config.json

`kanban config import-kit [--dry-run]` maps the legacy kit's config (plan §3.5). Each project with QA on gets kit
`team` (values that differ become overrides), landing `qa` and shadow. Every other project gets `default` with
landing `off`. Top-level routing is never copied onto a project. The main renames:

| kit.config.json | config.json |
|---|---|
| `projects[]` + toggles `QA_CREATE`/`AUTO_REWORK`/`AUTO_DONE` | `workspaces.<id>.landing.mode` + `workspaces.<id>.kit` |
| `AUTOLAND_DRY_RUN` | `workspaces.<id>.pipeline.shadow` |
| `projects[].baseBranch`, `.name`, `.projectBlurb`, `.qaPrompt.*`, `.postLand`, `.qaPreview` | `defaultBaseRef`, `name`, kit overrides `qa.blurb`, `qa.promptNotes.*`, `land.postLand`, `qa.preview` |
| `devAgent`, `qaAgent`, `qaRoutes`, `benchmark.*` | kit keys `roles.dev.agent`, `roles.qa.agent`, `qa.routes`, `tiers`/`dropped`/`tierRules`/`tierNotes` |
| `qaSlots`, `QA_TIMEOUT_MIN`, `QA_NUDGE_MAX`, `QA_VERDICT_GRACE_MS` | `pipeline.qa.slots`, `.timeoutMin`, `.maxNudges`, `.verdictGraceSec` |
| `QAFLOW_MAX_FAILS`, `REWORK_CLEAR_TURNS`, `REWORK_CLEAR_TOKENS` | `pipeline.rework.*` |
| `NUDGE_MAX`, `PREMATURE_MAX`, `TRANSIENT_BACKOFF_MIN`, `HUNG_MIN`, `HUNG_FIRST_MIN`, `OUTAGE_*` | `pipeline.recovery.*` |
| `WATCH_INTERVAL_SEC`, `STALL_*`, `RESUME_IDLE_MIN`, `NEW_CARD_GRACE_MIN`, `PROMPT_STUCK_MIN`, `PID_*`, `PRUNE_DONE*`, `TRIAGE_*` | `watchdog.*` |
| `WAKE_ORCHESTRATOR`, `wakeMode`, `WAKE_COOLDOWN_MIN`, `ORCH_*` | `orchestrator.wake.*` (`wakeTarget` is not imported: each workspace wakes its own orchestrator) |
| `PRETRUST`, `clineSessions`, `codexSessions` | `agents.*` |
| `providers`, `bedrockRegion`, `modelLists` | `models.*` |
| `BOARD_BACKUP_MIN`, `BOARD_BACKUP_KEEP` | `backups.board.*` |
| `kanbanUrl`, `runtimeUrl`, `kanbanCli`, `syncIntervalSec`, `logs.*`, `runDir`, `dataRoot`, `pricesDir`, `boardBackupDir` | gone: in-process, or a fixed path in the home |
| `run/<svc>.disabled` | `pipeline.paused`, `watchdog.mode: "off"`, `sessionSync.enabled: false` |
