# Folding the dev-team kit into the fork: design

Status: design only (card 1001c, 2026-10-06). Nothing in this document is implemented yet.
Inputs: the kit at `/root/.kanban` (main `cc6ef30`, 117 commits), and
this fork at `fork/stack` `67cac3a5` (0.1.70-fork.3: upstream main + #592 + #643 + #613/#615/#618 + #611 +
cline-only + opus-cache).

## 0. Summary

The kit is about 10.7k lines of plain Node: four polling services, a 586-line `kit` CLI, about 25 scripts and a
config loader. Its job is to run a board like a dev team: QA gates landing, failed work goes back to the same
card and model, crashes get nudges, and the orchestrator is woken when something needs it. The fork already has a
small piece of this in the runtime: `src/server/auto-review-reconciler.ts` arms a persisted `pendingGitAction` on
Review cards, types a commit/PR prompt into the agent's PTY, and moves the card to Done once HEAD moves.

Target:

- One TypeScript codebase in this repo.
- The kit's behaviour becomes runtime features with Kanban names: **pipeline** (was autoland), **session sync**
  (was column-sync), **watchdog** (was review-watch), and the **model-lists route** (was the model-lists service).
- The kit CLI becomes `kanban` subcommands.
- `kit.config.json` becomes typed keys in Kanban's own `config.json`.
- `~/.kanban` becomes the single **Kanban home** (`KANBAN_HOME`). It holds config, board state, worktrees,
  per-workspace data, logs and backups. It holds no code and is not a git repo.

Rule for overlaps: where both implement the same thing, the runtime mechanism is kept and the kit's lessons
(the incident-driven rules in its commit messages) are ported into it. Nothing exists twice after cutover.

## 1. Names

| Kit name | New name | Where it lives |
|---|---|---|
| "the kit", "dev-team kit", `~/.kanban` repo | **Kanban pipeline** (QA-gated landing) plus **watchdog**; docs say "team workflow" | `src/pipeline/`, `docs/team/` |
| `kanban-autoland` service | **pipeline** (`src/pipeline/engine.ts`); landing step = **QA gate** | runtime |
| `kanban-column-sync` service | **session sync** (`src/server/session-column-sync.ts`) | runtime |
| `review-watch` service | **watchdog** (`src/pipeline/watchdog.ts`) | runtime |
| `model-lists` service (:13306) | **model-lists route** `GET /api/model-lists/lemonade` on the Kanban server | runtime |
| `kit <cmd>` | `kanban <group> <cmd>` (table in §3) | `src/commands/*.ts` |
| `kit.config.json` | `$KANBAN_HOME/config.json`: `pipeline.*`, `watchdog.*`, `orchestrator.*`, `models.*`, `agents.*`, `workspaces.<id>.*` | `src/config/` (zod) |
| `checks-state.json` (`qaflow`) | `data/<ws>/pipeline-state.json` (same per-card shape, versioned) | data |
| `KANBAN_KIT_HOME`, `KIT_CONFIG`, `KIT_PROJECT` | `KANBAN_HOME`, `--home`, `--workspace` | |
| `<!-- kanban-kit:begin agents-qa … -->` | `<!-- kanban:managed begin agents-qa -->` (sync reads both for one release) | |
| `kanban-autoland@localhost` snapshot identity, "Landed by kanban-autoland" | `kanban@localhost`, "Landed by Kanban from task <id>" | |
| `run/<svc>.disabled` off switches | `kanban pipeline pause|resume [--workspace]` (persisted setting `pipeline.paused`) | config |
| `AUTOLAND_DRY_RUN` etc. | `workspaces.<id>.pipeline.mode: "off" | "shadow" | "on"` | config |

Names that stay as they are, because people, prompts and history already use them: `refs/kanban/snapshots/<id>`,
`preserve/*` tags, `qa-log.md`, `ATTENTION.md`, `scoreboard.jsonl`, `runoffs.json`, `restart-manifest.json`,
the verdict outbox `verdict.json`, and the `STATUS:` line contract.

## 2. Inventory

Legend for the **Fate** column:

- **R** = fold into the runtime (server process)
- **C** = becomes a `kanban` CLI command
- **P** = stays a separate process (with the reason)
- **D** = delete (duplicated or obsolete)
- **DATA** = machine data, moves to `~/.kanban/data`
- **A** = archived with the history only

### 2.1 Services

| Component | What it does today | Fate | New name |
|---|---|---|---|
| `services/kanban-autoland.mjs` (2392 lines) | fs.watch on board.json. Covers: snapshots, scripted checks, QA create/queue/slots, verdict ingest, PASS → merge-tree → `task done` → squash-land, rework, nudges, premature-stop, transient/outage probes, escalation, runoffs, restart recovery, board backups, approve marker, syncBase, qaPreview | **R**, split by feature (§2.6) | pipeline |
| `services/kanban-column-sync.mjs` | Browser-less copy of the UI's session→column moves, plus Cline-CLI "turn ended" heuristics (idle final reply, STATUS line, no-images after 2 min, 5 quiet min after a bounce). Never copies interrupted→trash. In flight: bc84c `988dc45` sends `hooks.ingest to_review` before moving | **R** | session sync (generic) + cline-cli turn detector (adapter) |
| `services/review-watch.mjs` | 60 s tick: restarts services, stall detection (review/QA/idle), dead-session continue, ATTENTION.md, orchestrator wake (headless/sidebar), TRIAGE cards, pid pressure/brownout, hourly prune-done, daily price sync. In flight: d84bc `3359bff` adds PRETRUST and "stuck on trust/permission prompt" | **R** | watchdog |
| `services/model-lists.mjs` | 127.0.0.1:13306 proxy of Lemonade's model list filtered to `tool-calling` | **R** (an HTTP route; one process less) | model-lists route |
| `services/ensure.sh` | `kit start --quiet` | **D** (nothing left to start) | |
| `services/kanban-runtime.mjs` | tRPC client: `sendChatMessage` (PTY typing + delivery check), `moveCard` (saveState with expectedRevision) | **D** in-process. The delivery check is ported into the runtime (§4.4) | `deliverTaskInput()` |

### 2.2 lib/

| Module | Fate | Notes |
|---|---|---|
| `config.cjs` | **D**, replaced by zod config + `kanban-home.ts` | Precedence env > project > top > default becomes config file > default. Env stays only for tests |
| `service.cjs` (registry, pidfiles, kit HEAD warning, `/proc` scans, `killUnder`) | **D**, except `killUnder` → `src/pipeline/process-tree.ts` | No services, no kit HEAD. The package version is the version |
| `kanban-cli.cjs` (`kanban --version` flavour, `devAgent()` per fork) | **D** | In-process there is only one Kanban |
| `card-model.cjs` (`agentSettings ?? clineSettings`) | **D** | Use the runtime's own card types |
| `cline-session.cjs` (Cline 3.x session dirs by worktree, `alive`, `supersedes`, `repeats`, `NO_IMAGES`) | **R** | `src/terminal/cline-session-files.ts` |
| `cline-hooks.cjs` (tail `~/.cline/data/logs/hooks.jsonl`, `parseStatus`) | **R** | Prefer Kanban's own hook ingest (`hooks-api.ts` already sees every cline-cli hook). Keep the jsonl reader only for `agent_error` text |
| `copilot-session.cjs` (`signedIn()` JSONC, session by worktree) | **R** | `src/terminal/copilot-session.ts`. Shares the JSONC parser with the trust-folder fix (§7.2) |
| `providers.cjs` | **C** | `kanban models providers` |
| `aws-prices.cjs` | **C** | `src/models/aws-prices.ts` (pure) |
| `resume.mjs` (`tagWip`, `resumeCard`) | **R** + **C** | `kanban task resume` |
| `restart-recovery.mjs` | **R** | The server knows its own start time, so the `/proc` btime scan goes away |
| in flight: `agent-trust.cjs`, `prompt-watch.cjs` (d84bc), `qa-route.cjs` (3c292) | **R** | §7.1 and §2.6 |

### 2.3 bin/ and the `kit` CLI → `kanban` subcommands

| Kit command or script | New command | Fate |
|---|---|---|
| `kit init <path>` | `kanban project add <path> [--pipeline] [--base B] [--blurb …] [--agents-md]` | **C** |
| `kit sync <path>` | `kanban project sync <path> [--dry-run]` (managed sections) | **C** |
| `kit check [path] [--fix]` | `kanban doctor [path] [--fix]` (fast, read-only unless `--fix`, exit 0) | **C** |
| `kit switch-check` (`post-switch-check.mjs`) | folded into `kanban doctor --deep` (agent CLIs, env, ssh mode, providers) | **C** |
| `kit machine-setup` | `kanban setup [--dry-run]`: npmrc, Cline rules, providers.json entries, Claude/Codex trust, the `~/.claude/CLAUDE.md` managed section. No bashrc, no prompt-template override | **C** |
| `kit start|stop|status` | `kanban pipeline status|pause|resume` (plus `restart` if the pipeline runs as a worker, §5) | **C** |
| `kit config` | `kanban config show [--workspace]`, `kanban config import-kit <kit.config.json>` | **C** |
| `kit handback` | `kanban task handback <id> --note … [--extra-rounds N]` | **C** (in-process: no stop/start dance) |
| `kit prepare-restart` | `kanban restart prepare [--dry-run]` | **C** |
| `kit recover-restart` | `kanban restart recover [--dry-run]` | **C** |
| `kit probe-models` | `kanban models probe <id…>` (`--list`; the `--openai` Mantle probes are **D**) | **C** |
| `kit providers` | `kanban models providers [--for M] [--cleanup] [--migrate-cards]` | **C** |
| `bin/resume-card.mjs` | `kanban task resume <id…>` | **C** |
| `bin/chat-card.mjs` | `kanban task send <id> <text|@file>` (uses `deliverTaskInput`) | **C** |
| `bin/approve-card.mjs` + `bin/commit-mode.mjs` + the `KANBAN-HUMAN-APPROVED` marker | **R**: on a `qa`-mode card the Commit button becomes **Approve & land** (runtime land action). CLI: `kanban task approve <id>` | **R**/**C**. The prompt-marker hack is **D** |
| `bin/orchestrator-wake.mjs` | **R** (watchdog launches it) + `kanban orchestrator wake <issue>` | **P** for the run itself: a headless `claude -p` is an agent run, launched by the runtime under a lock and timeout |
| `bin/wake-when.mjs` | `kanban orchestrator wake --when-card-done <id> | --when-model-up <m>` (a watchdog timer, no detached poller) | **R**/**C** |
| `bin/prune-done.mjs` | watchdog job + `kanban board prune-done [--days N] [--dry-run]` | **R**/**C** |
| `tools/restart-fresh.mjs` | `kanban task restart-fresh <id> --model … --label …` | **C** |
| `tools/recovery/restore-board.sh` | `kanban board restore <ws> [backup]` (Kanban stopped, or through the state API) | **C** |
| `tools/recovery/rebuild-board.mjs` | one-off from the 10/04 incident | **A** |
| `tools/migrate-legacy-home.sh` | done (10/05) | **A** |
| `tools/diagnostics/kanban-flowtrace.mjs` | logpoints at line numbers of the 0.1.70 dist | **D** |
| `tools/diagnostics/kanban-freeze-monitor.sh`, `sidebar-freeze-catch.sh` | `scripts/diagnostics/` in the repo (dev tools, not product) | **C**-adjacent: repo scripts |

### 2.4 qa/, bench/, probes/

| Component | Fate | New |
|---|---|---|
| `qa/qa-card.cjs` (QA v4 prompt, round count, `task create … --auto-review-enabled false`) + in-flight `qaRoutes` | **R** | `src/pipeline/qa-prompt.ts`, `qa-cards.ts`. Cards get a real `role: "qa"`, `reviewsTaskId` field instead of prompt/title regexes |
| `qa/qa-servers.sh` (Pawsome-specific) | **DATA**: a per-workspace script. `workspaces.foo.qa.serversScript` points at `data/foo/qa-servers.sh` | |
| `qa/qa-shot.cjs` (Playwright screenshots) | **C**: `kanban qa shot …` (run by QA agents in their scratch copy) | |
| `qa/calibrate.mjs` | **C**+**P**: `kanban bench calibrate <spec>` (long job, detached, resumable state in `data/<ws>/calibration/<name>/`) | Separate process because a run lasts hours and must survive a pipeline reload |
| `bench/record-verdict.cjs` | **R** (pipeline writes verdict lines) + `kanban bench record-verdict` for humans | |
| `bench/card-metrics.cjs` | **R** + `kanban bench metrics <id>` | `src/pipeline/card-metrics.ts` |
| `bench/scoreboard.cjs` | **C**: `kanban bench scoreboard` | |
| `bench/snapshot-reset.mjs` | **C**: `kanban bench reset <label>` | |
| `bench/sync-prices.mjs` | **C** + watchdog daily `--check`: `kanban models prices sync [--apply|--check]` | |
| `bench/prices.json` | **DATA** → `data/prices/prices.json` (package ships `assets/prices.default.json` as the seed) | |
| `bench/prices-aws.json` (154 KB, generated) | **DATA** → `data/prices/prices-aws.json`. Filtered out of the imported history | |
| `bench/model-prices.md` (hand-written price sources) | **DATA** → `data/prices/model-prices.md` | |
| `bench/backfill-scoreboard.cjs` | one-off Pawsome backfill | **A** |
| `probes/bedrock-converse-probe.mjs` | **C**: `kanban models probe` (also used by outage recovery) | |
| `probes/mantle-*.mjs` | deprecated openai-native path | **D** |

### 2.5 machine/, templates/, shell/, home files

| Component | Fate | New |
|---|---|---|
| `machine/npmrc` | **C**: `kanban setup` (or set in the image) | |
| `machine/cline-rules/*.md` (6) | **C**: shipped as `assets/cline-rules/`, installed by `kanban setup`. `dev-servers.md` is Pawsome-specific: move to the foo repo's `.clinerules` | |
| `machine/providers.template.json` | **C** asset (no secrets) | |
| `machine/kanban-prompts.json` (Commit/PR "don't" prompts) | **D**: qa-mode cards get an Approve button instead (§4.2) | |
| `machine/codex-config.toml.template` | **D** (never applied) | |
| `machine/bashrc.snippet` + `~/.bashrc` block `# >>> kanban kit >>>` | **D**: no services to start. Removed by the cutover card, with a backup | |
| `~/.bashrc` line 1 `PATH=$HOME/.kanban/shell:$PATH` | **D**: the image installs the helpers to `/usr/local/bin` | |
| `shell/` (bgrun, kp, killcomm, waitfor) | `deploy/agent-shell/`, copied into the image. `bgrun` pidfiles go to `$KANBAN_HOME/run/bgrun` | |
| `templates/AGENTS.qa-section.md` | **C** asset, `kanban project sync` | |
| `~/.claude/CLAUDE.md` (all kit text) | `kanban setup` writes a managed section ("run `kanban doctor <path>` at session start…"). The user's own text stays outside the markers | |
| `~/.claude/settings.json` permissions (`Bash(node /root/.kanban/bin/*)`, `Edit(/root/.kanban/*)`, the autoMode prose about `orchestrator-wake.mjs`) | **user step**: these are permission settings, so no agent edits them. The cutover card prints the exact replacement (`Bash(kanban *)`, `Edit(/root/.kanban/data/**)`) | |
| `~/.claude.json` `projects[...].hasTrustDialogAccepted` | **R**: §7.1 | |
| `~/.codex/config.toml` `[projects."…"] trust_level` | **R**: §7.1 | |
| `forks/secret-guard.sh` (tracked, pre-push hook) | `scripts/secret-guard.sh` in this repo. It reads `$KANBAN_HOME/data/*/*.env` | |

### 2.6 What autoland does, feature by feature

| Feature | Fate | Overlaps with the runtime? |
|---|---|---|
| Board watching (fs.watch, debounce, startup sweep) | **R**: subscribe to the in-process state hub (`broadcastRuntimeWorkspaceStateUpdated`) | Replaces disk polling |
| Snapshots `refs/kanban/snapshots/<id>` (temp index, commit-tree) | **R** `src/pipeline/snapshots.ts` | The reconciler's git probe; reuse its worktree helpers |
| Scripted checks (git archive → npm ci → `CHECK_SCRIPTS`) | **R** (child processes, serial queue) | none |
| QA create/queue/`qaSlots`/`qaAgent`/routes, QA preview start/stop | **R** | none |
| Verdict outbox ingest (`/tmp/qa-out/<qa>/verdict.json`) → qa-log, artifacts, scoreboard, QA card to Done | **R** | none |
| PASS: pre-done snapshot, `merge-tree` pre-check, land | **R**, as auto-review mode `qa` | **Yes**: auto-review commit mode (§4.2) |
| Squash-land (`commit-tree`+`update-ref` or `merge --squash` in the checked-out base) + `postLand` | **R** `src/workspace/land.ts` | **Yes**: agent-driven commit (§4.2) |
| FAIL → rework (prompt section, `.qa/r<N>/`, `/clear` thresholds, typed delivery, 2-min started-check) | **R** | Delivery: §4.4 |
| Merge conflict = FAIL | **R** | |
| Escalation (`BLOCKED:` + backlog, ESCALATE section, TRIAGE card), handback | **R** + `kanban task handback` | |
| Crash nudges, premature stop, poisoned history (/clear + resend), no-images, overflow cleanup | **R** `src/pipeline/recovery.ts` | Session states come from the runtime state machine |
| Transient retry, outage hold, model probes | **R** (probe in-process) | |
| Restart recovery (orphans, manifest, WIP tags, `startTaskSession`) | **R** | **Yes**: shutdown cleanup (§4.5) |
| Runoffs (hold PASS, decide, preserve tags, delete losers, `benchOnly`) | **R** | |
| Board backups (`board-latest.json`, every 10 min, 200 kept) | **R**: in `mutateWorkspaceState`'s write path (every write, not every watch event) | |
| `syncBase` (detach a clean stale worktree onto the base tip at start) | **R** in the task-start path | |
| Approve marker (`KANBAN-HUMAN-APPROVED`) | **D** → Approve button | |
| Kit HEAD warning | **D** | |

## 3. Settings (old key → new key)

All keys live in `$KANBAN_HOME/config.json`, validated by a zod schema (`src/config/team-config.ts`). Today's
global keys (`selectedAgentId`, `commitPromptTemplate`, …) stay where they are.

| kit.config.json | New key | Default |
|---|---|---|
| `projects[]` (the list of handled workspaces) | `workspaces.<id>.pipeline.mode` | `"off"` (opt-in per board; boards without it behave like upstream) |
| `projects[].baseBranch` | `workspaces.<id>.defaultBaseRef` (a card's `baseRef` wins) | detected |
| `projects[].name`, `projectBlurb`, `qaPrompt.*` | `workspaces.<id>.name`, `.blurb`, `.qa.promptNotes.{screenshotFallback,knownBaseIssues,dbSetup}` | |
| `projects[].postLand` | `workspaces.<id>.pipeline.postLand[]` | `[]` |
| `projects[].qaPreview` | `workspaces.<id>.qa.preview` | null |
| `projects[].scoreboard`, `qaLog`, `state`, `attention`, … | fixed: `data/<id>/…` (no per-file overrides) | |
| `devAgent` | `pipeline.devAgent` | `"cline"` |
| `qaAgent`, `qaSlots`, in-flight `qaRoutes` | `pipeline.qa.agent`, `.slots`, `.routes` | codex, 2, [] |
| `QA_TIMEOUT_MIN`, `QA_NUDGE_MAX`, `QA_VERDICT_GRACE_MS` (env) | `pipeline.qa.timeoutMin`, `.maxNudges`, `.verdictGraceSec` | 60, 2, 20 |
| `qaScratchRoot`, `qaOutRoot`, `chromiumLibs` | `pipeline.qa.scratchRoot`, `.outboxRoot`, `.chromiumLibs` | /tmp/kanban-qa, /tmp/kanban-qa-out, null (image libs) |
| `checksRoot`, `CHECKS`, `CHECK_SCRIPTS`, `CHECK_TIMEOUT_MIN`, `CHECK_ALLOW_SCRIPTS` | `pipeline.checks.{scratchRoot,enabled,scripts,timeoutMin,allowScripts}` | /tmp/kanban-checks, true, [typecheck,lint,test,build], 15 |
| `QAFLOW_MAX_FAILS` | `pipeline.maxFailRounds` | 3 |
| `REWORK_CLEAR_TURNS`, `REWORK_CLEAR_TOKENS` | `pipeline.rework.clearAfterTurns`, `.clearAfterTokens` | 100, 150000 |
| `NUDGE_MAX`, `PREMATURE_MAX`, `TRANSIENT_BACKOFF_MIN` | `pipeline.recovery.maxNudges`, `.maxContinues`, `.retryBackoffMin` | 2, 8, [1,2,4,8] |
| `OUTAGE_PROBE_MIN`, `OUTAGE_UPS`, `OUTAGE_MAX_MIN` | `pipeline.recovery.outage.{probeEveryMin,upsToResume,maxMin}` | 5, 2, 360 |
| `toggles.AUTO_DONE`, `AUTO_REWORK`, `QA_CREATE` | `pipeline.land`, `pipeline.rework.enabled`, `pipeline.qa.enabled` | true |
| `toggles.TRIAGE_CARDS` | `watchdog.triageCards` | false |
| `WATCH_INTERVAL_SEC`, `STALL_REVIEW_MIN`, `STALL_QA_MIN`, `STALL_IDLE_MIN`, `RESUME_IDLE_MIN`, `NEW_CARD_GRACE_MIN`, in-flight `PROMPT_STUCK_MIN` | `watchdog.intervalSec`, `.stall.{reviewMin,qaMin,idleMin,resumeIdleMin,newCardGraceMin,promptMin}` | 60, 10, 45, 30, 5, 10, 3 |
| `TRIAGE_COOLDOWN_MIN` | `watchdog.triageCooldownMin` | 120 |
| `PID_PRESSURE`, `PID_BROWNOUT` | `watchdog.pids.{pressure,brownout}` | 0.75, 0.9 |
| `toggles.PRUNE_DONE`, `PRUNE_DONE_DAYS` | `watchdog.pruneDone.{enabled,days}` | true, 3 |
| `toggles.WAKE_ORCHESTRATOR`, `wakeMode`, `WAKE_COOLDOWN_MIN`, `ORCH_TIMEOUT_MIN` | `orchestrator.wake.{enabled,mode,cooldownMin,timeoutMin}` | true, "headless", 30, 45 |
| in-flight `toggles.PRETRUST` | `agents.pretrust` | true |
| `providers` (`default`, `fallback`, `legacyUpstream`, `deprecated`) | `models.providers.{default,fallback,deprecated}` (`legacyUpstream` **D**) | bedrock |
| `benchmark.{tiers,dropped,tierRules,tierNotes}` | `models.tiers`, `.dropped`, `.tierRules`, `.tierNotes` | |
| `bedrockRegion`, `pricesRegion`, `toggles.PRICE_SYNC` | `models.bedrockRegion`, `models.prices.{region,autoSync}` | us-west-2, us-west-2, true |
| `modelLists` | `models.lists.lemonade.{url,requireLabels}` | http://localhost:13305, ["tool-calling"] |
| `BOARD_BACKUP_MIN`, `BOARD_BACKUP_KEEP` | `backups.board.{everyMin,keep}` | 10, 200 |
| `kanbanUrl`, `runtimeUrl`, `kanbanCli`, `syncIntervalSec`, `logs.*`, `runDir`, `dataRoot`, `pricesDir`, `boardBackupDir` | **D**: in-process, or a fixed path under `KANBAN_HOME` | |
| `kanbanHome`, `worktrees` | `KANBAN_HOME`, `worktreesRoot` (§6) | |
| `clineSessions`, `codexSessions`, `clineProviders` | `agents.cline.dataDir`, `agents.codex.home` | ~/.cline/data, ~/.codex |

Per-card: `autoReviewMode` gains `"qa"`, so the type becomes `"commit" | "pr" | "qa"`. On a workspace with
`pipeline.mode != "off"`, new dev cards default to `autoReviewEnabled: true, autoReviewMode: "qa"`. QA, TRIAGE
and calibration cards get `role` and are never auto-reviewed.

## 4. Overlap with the runtime auto-review code

### 4.1 What each side does today

| Responsibility | Runtime (fork/stack) | Kit | Conflict |
|---|---|---|---|
| In Progress → Review on turn end | **browser only** (`use-board-interactions.ts:416-480`). The server state machine marks `awaiting_review` but never moves columns | column-sync (server-side, from tRPC) | Both run when a browser is open. The UI bounced cards back from Review (fixed 10/06: c2add05, 7272572; bc84c's `988dc45` in flight) |
| Review → In Progress when running again | browser | column-sync | same |
| interrupted → Done (trash) | browser, `skipTrashWorkflow` | **deliberately not copied** (it trashed card 62a99) | The runtime's behaviour is the bad one |
| Review → land | auto-review `commit` mode: the agent is prompted to commit and cherry-pick onto base; done = HEAD moved → card to trash | QA verdict → Kanban-side squash-land; the agent never commits | **Double landing** if both are on (autoland L45). Today the kit keeps auto-review off and neutralizes the Commit/PR prompt templates globally |
| Persisted "action pending" | `pendingGitAction` on the card (CAS arm, 15-min stale, disarm off-Review) | `qaflow` in checks-state.json | two state models |
| Delivering text to an agent | `triggerTerminalGitAction`: `writeInput` + `\r` after 200 ms, no delivery check | `sendChatMessage`: PTY typing, second Enter if no activity in 8 s, Copilot focus-in escape, LOST_CONFIG detection | the kit's is strictly better |
| Card to Done workflow (stop session, keep patch, delete worktree, start linked backlog cards) | only in the browser's `performMoveTaskToTrash` and the CLI's `task trash`. `completePendingGitAction` only moves the card | `kanban task done` (CLI) | Server auto-review completions skip the cleanup and the dependents with no browser open |
| Shutdown | moves every work-column card to Done and deletes its worktree unless `--skip-shutdown-cleanup` (the image sets it since 42ecfca3) | restart recovery resumes orphans | The upstream default is destructive |
| Claude trust prompt | auto-confirms the TUI prompt for cwd under the worktrees home (`claude-workspace-trust.ts`) | d84bc: pre-trust the main git root in `~/.claude.json`, detect stuck cards | The runtime's auto-confirm evidently did not fire for bc84c/3c292 on 10/06 |

### 4.2 Landing: the runtime mechanism wins, extended with a `qa` mode

- The **auto-review reconciler stays the only actor that takes a Review card to Done.** The pipeline does not get
  a second "land" loop. Instead, `autoReviewMode: "qa"` adds a stage machine to the same reconciler:
  `snapshot → checks → qa_pending → qa_running → verdict → (land | rework | escalate)`.
  `pendingGitAction` keeps its role as the persisted, CAS-armed "an action is in flight" record, with a new
  action `"land"`. Long history (`handled[]`, `reworks[]`, outages, runoffs) lives in `data/<ws>/pipeline-state.json`.
  The board card carries only what the UI shows (`pipelineStage`, round). So there is one actor and one in-flight
  record, and history stays out of the broadcast board.
- **Landing is done by Kanban, not the agent**, in `qa` mode: the kit's `land()` ported to `src/workspace/land.ts`
  (merge-tree pre-check, `commit-tree` + `update-ref` when the base isn't checked out, `merge --squash` with stash
  in the checked-out base, `postLand`). Order changes from the kit's: **land first, then trash**. The kit lands
  after `task done` from the trashed-task patch only because the Done move was its trigger. Landing first means a
  conflict found at land time leaves the card in Review and turns into a rework, and dependents start only after
  the base really has the work.
- `commit`/`pr` modes stay unchanged for boards without the pipeline.
- The Commit / Open PR buttons on a `qa` card become **Approve & land** (the same land action, skipping QA,
  recorded as `HUMAN_APPROVED`). This deletes `kanban-prompts.json`, `commit-mode.mjs`, `approve-card.mjs` and the
  marker. A manual drag to Done on a `qa` card asks "land or discard?" instead of landing silently.
- **One server-side Done workflow** (`src/server/task-trash-workflow.ts`): stop session → save patch → delete
  worktree → start linked backlog cards. It is used by CLI `task trash`, the reconciler, and the pipeline (QA
  cards, runoff losers). The browser calls it through tRPC instead of running its own copy.

### 4.3 Column moves: the runtime owns them server-side

- New `session-column-sync.ts`: on each session state transition the server moves `in_progress ↔ review` with
  `mutateWorkspaceState`. The rules are column-sync's, including the `updatedAt` guard: only a session summary
  newer than the card moves it.
- The browser stops moving columns (it renders server state). This removes the bounce for good.
- interrupted → Done is **not** ported. Interrupted cards stay where they are and the watchdog reports them.
- Cline-CLI "turn ended" detection (idle final reply, `STATUS:` line, QA final line, no-images after 2 min,
  quiet after bounce) becomes part of the **cline-cli adapter**. It emits `to_review` into the state machine
  (as bc84c's `hooks.ingest` does from outside), so session sync stays agent-agnostic.

### 4.4 Delivery: one function

`deliverTaskInput(taskId, text, {enter, confirm})` in `src/terminal/` does the work:

- PTY typing with newline flattening;
- a separate Enter;
- the Copilot focus-in escape;
- an activity check over `lastOutputAt`/`lastHookAt`, a second Enter, and `{undelivered}`.

The auto-review prompt, rework, nudges, `kanban task send` and the sidebar wake all use it. It is also exposed
over tRPC so the kit's `kanban-runtime.mjs` can call it during the transition.

### 4.5 Restart: runtime recovery, cleanup off for pipeline boards

`--skip-shutdown-cleanup` becomes the default when any workspace has `pipeline.mode != "off"`, so the image no
longer depends on the flag. Restart recovery runs in the server at startup: it knows its own start time, so there
is no `/proc` scan. `kanban restart prepare` writes the manifest exactly as `kit prepare-restart` does today.

## 5. In-process or a supervised worker (decision 1)

Today a kit fix goes live with `kit start --reload-if-changed` and no card dies. A Kanban restart kills every
running card, because the PTYs are children of the server, and it is a **container restart** done by the user on
the host. The kit had 67 commits on 10/06 alone. If the pipeline lives in the server process, every pipeline fix
costs a container restart.

Recommendation:

- Session sync, the Done workflow, delivery, trust and the home resolver go **in the server** (they are Kanban
  semantics and change rarely).
- The **pipeline + watchdog** run as one **supervised child process** of the server (`kanban pipeline worker`,
  same package, same code, typed API over a local socket or tRPC). The server restarts it on crash, and
  `kanban pipeline restart` reloads it without touching PTYs.
- In the dev pod the worker entry can point at a newer build (`pipeline.workerEntry`, e.g.
  `/projects/kanban/dist/pipeline-worker.js`). That keeps the kit's "fix it live" loop without a second codebase.
- Alternative: everything in-process. Simpler, but slower to iterate: every fix waits for a container restart.

## 6. Kanban home

### 6.1 Resolution (`src/state/kanban-home.ts`, the only place that knows paths)

1. `kanban --home <dir>`
2. `KANBAN_HOME`
3. `~/.kanban`, if it has `config.json` with `"home": 1` or a `workspaces/` dir (an initialized home)
4. `~/.cline/kanban`, if it exists (legacy; `kanban doctor` says "run `kanban home migrate`")
5. `~/.kanban` (fresh installs)

- Worktrees: `worktreesRoot` (config) or `KANBAN_WORKTREES`, default `<home>/worktrees`.
- `legacyWorktreeRoots` (default `["~/.cline/worktrees"]` after a migration) is searched read-only when a task's
  worktree is not in the new root. Live worktrees are never moved; they drain as their cards finish (§8.3).
- Project-local `<repo>/.cline/kanban/config.json` (shortcuts) stays, since it is in the project.
- Cline's own `~/.cline/data` stays: it belongs to Cline, not Kanban.
- The 10 hard-coded sites that change: `workspace-state.ts:23-25,161-167`, `runtime-config.ts:50-55,115-117,206`
  (a private duplicate of the home path), `task-worktree-path.ts:3-6` (also used by web-ui), `runtime-api.ts:70-72`
  (debug reset), `debug-dialog.tsx:65-66,93-94` and `runtime-settings-dialog.tsx:963` (UI text: take it from the
  API), `append-system-prompt.ts:150`.
- A test fails on any literal `.cline/kanban`, `.cline/worktrees` or `.kanban` outside `kanban-home.ts`.

### 6.2 Target layout

```
~/.kanban/                         KANBAN_HOME (machine state only; not a git repo)
  config.json                      Kanban global config + pipeline/watchdog/orchestrator/models/agents/workspaces.<id>
  workspaces/index.json            Kanban board state (was ~/.cline/kanban/workspaces; internal layout unchanged)
  workspaces/<id>/{board,sessions,meta}.json
  hooks/<agent>/                   was ~/.cline/kanban/hooks
  trashed-task-patches/            was ~/.cline/kanban/trashed-task-patches
  worktrees/<taskId>/<repo>/       new task worktrees (old ones stay in ~/.cline/worktrees until done)
  data/<id>/                       per-workspace pipeline data (path unchanged for foo):
     pipeline-state.json  qa-log.md  ATTENTION.md  scoreboard.jsonl/.md  runoffs.json  restart-manifest.json
     watchdog-state.json  qa-artifacts/  calibration/<name>/  bench/  orchestrator-{actions,plan,queue}.*
     qa-servers.sh (foo)  *.env (secrets; never in git)
  data/prices/                     prices.json, prices-aws.json, model-prices.md, raw/, state.json
  logs/                            server.log, pipeline.log, watchdog.log, orchestrator*.log, calibrate.log, price-sync.log
  backups/                         boards/<id>/{board-latest,board-<ts>}.json, home-migrate-<ts>.tgz, devteam-kit-final.tgz, *.bak-*
  run/                             locks (orchestrator-<id>.lock, pipeline-worker.pid), bgrun/
  vendor/chromium-libs/            only until the image ships the Playwright libs
```

`workspaces/` stays separate from `data/` on purpose:

- `workspaces/` is Kanban's revision-locked state, keeps upstream's layout, and rebases cleanly.
- `data/` is pipeline output that people and agents read.

## 7. In-flight work to carry over

### 7.1 Card d84bc (kanban board, Review): Claude Code / Codex trust

- Kit commit `3359bff` (unmerged, detached worktree `~/.cline/worktrees/d84bc/.kanban`) adds:
  - `lib/agent-trust.cjs`: trust key = the **main git root** (follows the worktree's `gitdir:`/`commondir`).
    It does a CAS read-modify-write of `~/.claude.json` `projects[<root>].hasTrustDialogAccepted`, with 5 tries
    and an mtime/size/content check, and an append-only Codex `[projects."<root>"] trust_level = "trusted"`.
  - `lib/prompt-watch.cjs`: a card that is running past `PROMPT_STUCK_MIN` with no hook gets flagged
    "trust"/"startup"; an unanswered `permission_prompt`/`PermissionRequest` hook gets flagged "approval".
  - Wiring: `kit init` and `kit check --fix`, review-watch PRETRUST over every registered workspace, and
    `test/agent-trust.test.cjs`.
- Now: finish d84bc on the kit (QA → land), so the live pod stops needing hand-accepted prompts.
- Port (card P1-3):
  - Pre-trust moves into `src/terminal/claude-workspace-trust.ts` and `codex-workspace-trust.ts`. It runs at
    workspace registration and before every Claude/Codex PTY spawn, keyed by the main git root.
  - `kanban doctor` reports missing trust and `--fix` adds it.
  - Keep the TUI auto-confirm as a fallback, and find out (don't guess) why it missed the 10/06 prompts: is it a
    prompt-text change in the current Claude Code, or a cwd mismatch?
  - The stuck-prompt detector goes into the watchdog (P4-7).

### 7.2 Copilot `~/.copilot/config.json` JSONC wipe

- The bug is real on fork/stack: `addCopilotTrustedFolder` (`src/terminal/agent-session-adapters.ts:1616-1644`,
  called at :1884 on every Copilot launch) uses `JSON.parse`. The `catch` swallows the parse error of the JSONC
  header and rewrites the file with only `trustedFolders`, which wipes `authTokens`/`loggedInUsers`. The installed
  0.1.70-fork.3 has it too.
- **A fix exists (card c5c2b) but is unpushed and not in fork/stack.** The orchestrator copied the old clone's
  branches into `/projects/kanban` (20:5xZ):
  - `local-forks/fork/cline-only` **`1b1f54c8`**: the one commit not in fork/stack. Its branch was 3 commits
    behind fork/stack, so it needs a cherry-pick, not a merge.
  - `local-forks/fork/copilot` **`86866b9f`**: the same fix on the copilot feature branch.
  - It parses with `stripJsonComments`, keeps every key and the comment header, writes through a temp file +
    rename, and leaves the file untouched (with a `sessionWarning`) if it can't parse.
- Carry-over (card P0-2): `git cherry-pick 1b1f54c8` onto fork/stack. Run the tests, and the build if it needs
  one. Point `fork/copilot` at `86866b9f`. Share the JSONC reader with `copilot-session.signedIn()` (P4-6).

### 7.3 Kit commits that landed tonight (kit main `cc6ef30`)

These are part of the inventory and get ported like the rest of the kit:

| Kit commit | What | Ported by |
|---|---|---|
| `35b95ca` column-sync `hooks.ingest to_review` before the move (was bc84c `988dc45`) | stops the UI bouncing a finished Cline turn back to In Progress | P2-1/P2-2: the server emits `to_review` itself |
| `2852764` kit boot + kit-start lock (was bc84c `8a59e4b`) | services start with Kanban at a container start | **D** once nothing needs starting. Until P5-2 it is what keeps the kit alive across restarts |
| `7d08918` qaRoutes (was 3c292 `22557f3`) | QA model by dev vendor (OpenAI-built cards → Haiku 4.5 on Cline + "drive the changed path") | P4-3 (`pipeline.qa.routes`, `qa-routing.test.ts`) |
| `cc6ef30` agent trust + prompt-watch (was d84bc `3359bff`) | §7.1 | P1-3 (trust), P4-7 (stuck-prompt detection) |

The archive (P0-3) is cut at `cc6ef30` or later.

### 7.4 Retiring `~/.kanban/forks` (4.2 GB inside the kit dir)

`/projects/kanban` is the canonical fork checkout from now on. Everything under `~/.kanban/forks` is either rescued
into it or deleted. None of it stays in the Kanban home.

| Path | What it is | Fate |
|---|---|---|
| `forks/kanban` (fork/stack `67cac3a`, remote `vombor`) + linked worktrees `kanban-{cline,copilot,cache,perf,ux}` | the old fork clone | Branches are already copied to `/projects/kanban` as `local-forks/fork/*` and `local-forks/backup/*`. After P0-2: delete the clone and its worktrees (`git worktree remove` each, then `rm -rf forks/kanban`) |
| `local-forks/fork/cline-only` `1b1f54c8`, `local-forks/fork/copilot` `86866b9f` | Copilot JSONC fix | cherry-pick onto fork/stack (P0-2) |
| `local-forks/fork/ux-batch` `ccfa73d` (board websocket keep-alive behind tunnels) | unpushed feature commit | P0-2b: rebase onto fork/stack as `fork/ux-batch`, review, merge into fork/stack like the other fork PR branches |
| **uncommitted** changes in `forks/kanban-ux` (116 insertions: `src/trpc/runtime-api.ts`, `test/runtime/trpc/runtime-api.test.ts`, `web-ui/src/styles/globals.css`, `web-ui/src/terminal/persistent-terminal-manager.ts`) | WIP, in no commit | P0-2b first: `git -C forks/kanban-ux diff --binary > ~/.kanban/backups/kanban-ux-wip-<ts>.patch`, then commit it as WIP on a branch `wip/ux-batch-uncommitted` in `/projects/kanban` (`git apply`). Who owns it decides later whether to finish or drop it |
| `local-forks/fork/{stack,perf,opus-cache,cli-agents}`, `local-forks/backup/*` | identical to or older than `vombor/*` | keep as refs for one release cycle, then delete the `local-forks/*` refs (P5-3) |
| `forks/kanban-cache-patch/` (patch experiment, 126 MB), `forks/scratch/` (cline/core/llms tarballs, `rm*.cjs` fork.3 surgery scripts, logs), `forks/cline-cli/` (an npm install of cline), `forks/deploy-draft/` (already in `deploy/`), `forks/sandbox*`, `*.log`, `pilot-id`, `smoke-id` | experiments and sandboxes. Not git repos (they sit in the kit repo's ignored `forks/`) | delete. `scratch/*.tgz` are reproducible from npm. Before deleting, keep the logs in `backups/forks-logs-<ts>.tgz` (small) |
| `forks/secret-guard.sh` (tracked in the kit) | the fork's pre-push hook | `scripts/secret-guard.sh` in this repo (P0-3), wired as `.husky/pre-push` locally in `/projects/kanban` |
| `/root/.cline/worktrees/c5c2b/.kanban` (kit worktree, nothing ahead of main) | c5c2b's own worktree | trashed with the card |

Order: P0-2/P0-2b land → verify each rescued commit is reachable from a `/projects/kanban` branch
(`git branch --contains`) → write the WIP patch backup → delete. `forks/` is removed in P5-3 at the latest. It
can go as soon as P0-2/P0-2b are done; nothing in the running pod uses it (the image comes from GitHub, the pod's
kanban from `/usr/local/lib/node_modules`).

## 8. Migration and cutover

### 8.1 Live state (2026-10-06 ~20:40Z)

- Container: image fork.3 package at `/usr/local/lib/node_modules/kanban`, `kanban --port 3485 --no-open
  --no-passcode --skip-shutdown-cleanup`. Kit services `autoland`, `column-sync`, `review-watch` and
  `model-lists` run from `/root/.kanban`, started by the bashrc hook.
- Boards:
  - `foo` (/projects/foo): in progress e5c23 (QA-CAL, local GLM), a2cbb and e527b (multi-region bench);
    backlog includes `BLOCKED:` aa1fe.
  - `kanban` (/root/.kanban): kit cards. d84bc, bc84c and 3c292 landed on kit main tonight (`cc6ef30`);
    c5c2b's fix waits for P0-2.
  - `kanban-2uge` (/projects/kanban, base fork/stack): this card. It is a kit workspace since 20:5xZ, so the
    port cards are QA-gated by the current kit: autoland squash-lands onto fork/stack in the `/projects/kanban`
    checkout.
- From then on the fork is dogfooded: until P5-2, the kit lands the cards that replace it.

### 8.2 Principles

- **One owner per responsibility at any time.** Every runtime feature ships **off or in shadow mode** and is
  switched on per workspace. The matching kit service or toggle is switched off in the same step (by the cutover
  card). `kanban doctor` fails if both own the same thing: it reads `run/*.pid` and the kit toggles.
- **Releases batch runtime cards.** Each runtime release (fork.4, fork.5, …) needs a new image and a container
  restart done by the user on the host. Before each one: `kit prepare-restart` (later `kanban restart prepare`),
  plus a backup tarball of `~/.cline/kanban`, `~/.kanban/data` and `~/.kanban/kit.config.json`.
- **The kit keeps running until its last responsibility moves.** No edits under `/root/.kanban` code are needed
  for the transition, except one compatibility edit in P3-1 (the kit reads the new config) — that card is a kit
  card on the kit board.

### 8.3 The hard parts

- **Hardcoded paths.**
  - About 133 literal `~/.kanban` / `/root/.kanban` occurrences across 40 files. Most are docs (RUNBOOK 35),
    plus 15 `path.join(H, ".kanban", …)`, 18 `.cline/worktrees`, and 11 `/projects/foo` / "foo" defaults.
  - None are carried over: the ported code resolves paths through `kanban-home.ts`, and the docs are rewritten
    into `docs/team/`.
  - What survives outside code:
    - prompts already stored in cards (QA, TRIAGE, rework text with `~/.kanban/...` paths);
    - ATTENTION.md lines such as `node /root/.kanban/bin/resume-card.mjs`;
    - `~/.claude/settings.json` permissions;
    - `~/.claude/CLAUDE.md`.
  - The cutover card lists open cards whose prompt contains `/.kanban/bin` or `kit ` and updates them
    (`kanban task update`) or lets them finish before the kit code is removed.
  - The ported data paths stay valid: `~/.kanban/data/<ws>/` is unchanged.
- **Removing the kit repo breaks the `kanban` board.**
  - The board's repoPath is `/root/.kanban`. Kanban drops a workspace whose `git rev-parse` fails (the 10/04
    "board wiped" incident), and the kit cards' worktrees are worktrees of that repo.
  - Order: finish or trash every card on the `kanban` board, remove the workspace from Kanban's index, then
    remove `.git`.
  - Future tooling cards go on `kanban-2uge` (/projects/kanban).
- **Kanban home = ~/.kanban while ~/.kanban is still the kit repo.** Board files and worktrees would be
  untracked files in the kit repo, and a `git add -A` there could commit them. So the home move (P5-3) comes
  **after** the repo is retired (P5-2).
- **Worktrees are not moved.**
  - Their paths are absolute in many places: git worktree metadata, Cline session `cwd`/`workspace_root` (the
    session ↔ card mapping), Claude transcripts under `~/.claude/projects/<escaped path>`, trust keys, Copilot
    `trustedFolders`, and `.cline/hooks` in the worktree.
  - New cards get `<home>/worktrees`, and existing ones keep resolving through `legacyWorktreeRoots`.
  - `kanban home migrate --worktrees` can later move **idle** (backlog/done) worktrees: it runs
    `git worktree repair` and refuses running cards.
- **Running cards at each restart.** `kit prepare-restart` (tags WIP, manifest) and autoland's recovery resume
  them after the restart. From fork.5 on, the runtime's own recovery takes over only once the cutover card has
  enabled it **and** paused the kit's restart recovery. Never both: the double resume would start two sessions.

### 8.4 Cutover steps (P5-1 … P5-4)

1. **Shadow day.** In foo, set `pipeline.mode: "shadow"` (the release that has P4-x). The pipeline logs every
   decision it would take next to the kit's (`logs/pipeline.log` vs `kanban-autoland.log`). The shadow-diff script
   compares them. Fix the differences, run again. Exit criterion: 24 h with no unexplained difference on a busy
   board.
2. **Switch foo.**
   - Do this when no card is mid-QA or mid-land, and no runoff is undecided.
   - `touch ~/.kanban/run/{autoland,review-watch,column-sync}.disabled` (column-sync goes earlier, at P2), then
     `kit stop`.
   - Set `pipeline.mode: "on"`.
   - `kanban config import-kit` (reads kit.config.json once; it is then kept only as a backup).
   - `checks-state.json` is copied to `pipeline-state.json`. The format is the same, plus `version`.
   - Watch one full card cycle.
3. **Retire the kit repo.**
   - First: the `kanban` board is empty and removed from the index; `forks/` is already retired (§7.4, P0-2b);
     sandboxes and `compat/` are deleted.
   - `tar -czf backups/devteam-kit-final.tgz .git bin lib services qa bench probes tools shell machine templates
     test docs attic README.md .gitignore kit.config*.json`, then remove those paths.
   - Move `bench/prices*.json` and `model-prices.md` to `data/prices/`.
   - Remove the bashrc block and PATH line (with a backup).
   - `kanban setup` rewrites the CLAUDE.md managed section.
   - The user applies the printed `~/.claude/settings.json` permission changes.
4. **Move the home** (in a restart window, Kanban stopped):
   - `kanban home migrate --from ~/.cline/kanban --to ~/.kanban` copies config/workspaces/hooks/patches, writes
     `backups/home-migrate-<ts>.tgz`, sets `legacyWorktreeRoots`, and writes the home marker.
   - The pod spec gets `KANBAN_HOME=/root/.kanban` (explicit, so a rollback is just removing it).
   - `~/.cline/kanban` is renamed to `~/.cline/kanban.migrated-<ts>`, not deleted.

### 8.5 Image

- `deploy/Containerfile`:
  - add `deploy/agent-shell/*` → `/usr/local/bin`;
  - add the Playwright Chromium system libs (apt; then `vendor/chromium-libs` goes);
  - keep the cline Bedrock cache patch step.
- The CMD stays (with `--skip-shutdown-cleanup` until §4.5 lands, then harmless).
- `ENV KANBAN_HOME` is **not** baked into the image. The pod sets it, so the same image runs on an unmigrated home.
- `.github/workflows/image.yml` needs no structural change. `npm test` picks up the ported tests, so their runtime
  matters: no real agent processes (AGENTS.md: Node 22 CI hang).
- Releases stay on `fork/**` branches. `fork/stack` stays the `:latest` source.

### 8.6 Rollback

| Step | Rollback |
|---|---|
| any runtime feature (P1–P4) | set the workspace setting off or `pipeline.mode: "off"`, `rm ~/.kanban/run/<svc>.disabled`, `kit start` |
| a release | the previous image digest (`podman image inspect … .Digest` is recorded in each release card) |
| P5-2 (foo switch) | `pipeline.mode: "off"`, re-enable the kit services. `pipeline-state.json` → `checks-state.json` (same format; the kit ignores `version`) |
| P5-3 (repo retired) | `tar -xzf backups/devteam-kit-final.tgz -C ~/.kanban`, restore the bashrc block from its backup, `kit start` |
| P5-4 (home moved) | remove `KANBAN_HOME` from the pod, rename `~/.cline/kanban.migrated-<ts>` back. Worktrees never moved. Boards changed after the move are in `~/.kanban/workspaces` and can be copied back the same way |

## 9. Tests

The kit has no runner: `test/*.test.cjs` are top-level `assert` scripts, plus two shell dry-run diffs. The fork
uses vitest. Root `vitest.config.ts` runs `test/runtime`, `test/utilities` and `test/integration`; `web-ui` has its
own jsdom config.

| Kit test | Fork test |
|---|---|
| `aws-prices.test.cjs` | `test/runtime/models/aws-prices.test.ts` (same fixtures) |
| `cline-hooks.test.cjs` | `test/runtime/terminal/cline-turn-outcome.test.ts` |
| `fork-compat.test.cjs` | session-dir mapping → `test/runtime/terminal/cline-session-files.test.ts`; cardModel parts **D** |
| `cline-agent-id.test.cjs` | **D** (no version sniffing in-process) |
| `agent-trust.test.cjs` (d84bc) | extend `test/runtime/terminal/claude-workspace-trust.test.ts`, `codex-workspace-trust.test.ts` |
| `qa-route.test.cjs` (3c292) | `test/runtime/pipeline/qa-routing.test.ts` |
| `column-sync-ui-bounce.test.mjs` (bc84c) | `test/runtime/server/session-column-sync.test.ts` |
| `equivalence.sh` (old vs new autoland, dry run on a board copy) | shadow mode + `scripts/pipeline-shadow-diff.ts` during cutover, then **D** |
| `qa-prompt-diff.sh` | fixture tests of `buildQaPrompt` (`test/runtime/pipeline/qa-prompt.test.ts`) |
| (none) | `test/integration/pipeline-land.integration.test.ts`: temp repos for clean / conflict / noop / base-checked-out-with-dirty-tree land. Same for snapshots and runoff tags |

Shared helpers to add:

- `test/utilities/kanban-home.ts` `withTemporaryKanbanHome()`. It replaces the per-file `HOME` hacks and is used by
  every pipeline test.
- `createGitTestEnv()` already strips `GIT_*`.
- Agent spawns, the `claude -p` wake and probes are injected, never real.

## 10. Git history and data

- **Don't merge the kit's history into fork/stack.** It is 117 commits with an unrelated root. It would make
  upstream merges noisier, and the code is being rewritten in TypeScript anyway, so `--follow` would not carry
  across.
- Instead:
  1. `git filter-repo` a copy:
     - drop `bench/prices-aws.json`, `bench/prices.json`, `bench/model-prices.md` (data);
     - drop `kit.config*.json` (example only);
     - move `forks/secret-guard.sh` → `scripts/`.
  2. Run a secret scan over the result: key shapes, **and** `secret-guard.sh`'s exact-value check against this
     machine's secrets. The key-shape scan of the current history is clean (one false positive, "task-agent-…").
     The exact-value scan needs the user's go-ahead: the agent classifier blocks an agent from reading the
     credential files.
  3. Push the result as orphan branch **`archive/devteam-kit`** (+ tag `devteam-kit-final`) in this repo (only
     after the user OKs pushing it).
- Each port commit says `Ported from archive/devteam-kit:<path>@<sha>`. The incident reasoning lives in the kit's
  commit messages (`git log archive/devteam-kit -- services/kanban-autoland.mjs`). `docs/team/HISTORY.md` indexes
  the rules that came from incidents.
- Alternative: `git subtree add --prefix=legacy/devteam-kit` into fork/stack (full history, files deleted as they
  are ported). It is simpler to browse, but adds the unrelated history to the release branch forever.

Data, not code (goes to `~/.kanban/data`, never into the repo):

- `bench/prices.json`, `prices-aws.json`, `model-prices.md` → `data/prices/`;
- `kit.config.json` → `config.json`;
- `data/foo/bench/` (benchmark inputs, runoff outputs, snapshots), `calibration/`, `qa-artifacts/`;
- `qa-servers.sh` (Pawsome) → `data/foo/`;
- `run/bedrock-profiles.json` → cache in `data/models/`.

Docs:

- `WORKFLOW.md`, `RUNBOOK.md`, `CONFIG.md` → rewritten as `docs/team/` with the new names.
- `FORK-REVIEW.md`, `FORK-PERF.md`, `SWITCH-TO-FORK.md`, `POD-KEEPALIVE.md`, `COPILOT.md`, `upstream/` → `docs/fork/`.
- `attic/`, `compat/` → deleted after cutover. `forks/` → rescued, then deleted. `backups/` stays.

## 11. Implementation cards

Each card is one agent's work, leaves the pod working (new behaviour off or in shadow by default), and lands on
`kanban-2uge` (base `fork/stack`). "∥" means it can run in parallel with the others in its phase.

**Phase 0: carry-over (no runtime release)**

| Card | Scope | Depends on |
|---|---|---|
| P0-1 | ~~Finish d84bc, bc84c, 3c292 on the kit~~: done, kit main `cc6ef30` (§7.3) | – |
| P0-2 ∥ | Copilot JSONC fix: cherry-pick `local-forks/fork/cline-only` `1b1f54c8` onto fork/stack, move fork/copilot to `86866b9f`; tests. Ships in fork.4 | – |
| P0-2b ∥ | Rescue `forks/kanban-ux`: WIP patch backup, uncommitted diff → `wip/ux-batch-uncommitted`, `ccfa73d` rebased as `fork/ux-batch`; then retire `~/.kanban/forks` per §7.4 (delete the clone, worktrees and sandboxes once every rescued commit is reachable from `/projects/kanban`) | – |
| P0-3 ∥ | History archive (cut at kit main ≥ `cc6ef30`): filter-repo, secret scans (user runs the exact-value one), orphan branch `archive/devteam-kit` locally, `scripts/secret-guard.sh`, `docs/team/HISTORY.md` index. No push without the user | – |

**Phase 1: foundations (release fork.4)**

| Card | Scope | Depends on |
|---|---|---|
| P1-1 ∥ | `src/state/kanban-home.ts` resolver, `--home`/`KANBAN_HOME`/`worktreesRoot`/`legacyWorktreeRoots`; replace the 10 hard-coded sites; UI shows paths from the API; grep-gate test; `withTemporaryKanbanHome`. On the pod it still resolves `~/.cline/kanban` (no change) | – |
| P1-2 | `kanban home migrate [--dry-run] [--worktrees]` (refuses while the server runs; backup tarball; marker) | P1-1 |
| P1-3 ∥ | Claude/Codex pre-trust by main git root in `claude-workspace-trust.ts`/`codex-workspace-trust.ts` (port of d84bc's agent-trust), before every spawn; diagnose the missed TUI auto-confirm | P0-1 (d84bc landed) |
| P1-4 ∥ | `task-trash-workflow.ts`: one server-side Done workflow used by CLI trash, the auto-review reconciler and the browser | – |
| P1-5 ∥ | `deliverTaskInput()` with delivery confirmation; the reconciler uses it; exposed via tRPC (kit's `kanban-runtime.mjs` can switch to it) | – |

**Phase 2: session sync + model lists (release fork.5)**

| Card | Scope | Depends on |
|---|---|---|
| P2-1 | `session-column-sync.ts` (server moves `in_progress ↔ review`, `updatedAt` guard, no interrupted→trash); the browser stops moving columns; setting `sessionSync` default on for this fork. Cutover: disable kit column-sync | P1-4 |
| P2-2 ∥ | cline-cli turn-end detector in the adapter (idle final reply, STATUS line, QA final line, no-images, quiet-after-bounce; from column-sync + bc84c) | – |
| P2-3 ∥ | `/api/model-lists/lemonade` route + config; Cline `modelsSourceUrl` updated by `kanban setup`; retire the model-lists service | – |

**Phase 3: config + CLI (release fork.5 or fork.6)**

| Card | Scope | Depends on |
|---|---|---|
| P3-1 | zod team config (§3) in `config.json`; `kanban config show|import-kit`. Plus a small **kit card**: `lib/config.cjs` reads the imported keys from Kanban's config.json when present, so there is one config file from here on | P1-1 |
| P3-2 | `kanban doctor [--fix] [--deep]` (kit check + switch-check + "one owner" check + trust), `kanban project add|sync`, `kanban setup` (npmrc, rules, providers, CLAUDE.md section, trust; no bashrc) | P3-1, P1-3 |
| P3-3 ∥ | `kanban models probe|providers|prices sync` (port aws-prices, bedrock probe, providers; data in `data/prices`) | P3-1 |
| P3-4 ∥ | `kanban bench metrics|record-verdict|scoreboard|reset` (card-metrics, record-verdict, scoreboard) | P3-1 |

**Phase 4: pipeline (shadow first; release fork.6)**

| Card | Scope | Depends on |
|---|---|---|
| P4-1 | Pipeline skeleton: worker process (or in-process, per decision 1), state store `pipeline-state.json` (reads checks-state.json), events from the state hub, `mode off|shadow|on`, decision log; `autoReviewMode: "qa"` + card `role` in the API contract and UI | P2-1, P3-1 |
| P4-2 | Snapshots + scripted checks + board backups | P4-1 |
| P4-3 | QA: prompt builder (+qaRoutes), QA cards, slots/queue, outbox ingest, qa-log/scoreboard, qaPreview, `kanban qa shot` | P4-1, P3-4 |
| P4-4 | Land: `land.ts` (merge-tree, squash, postLand) → Done workflow; Approve & land button; `kanban task approve` | P4-1, P1-4 |
| P4-5 | Rework, escalation (`BLOCKED:`, ESCALATE), `kanban task handback`, runoffs | P4-3, P4-4 |
| P4-6 | Recovery: nudges, premature stop, poisoned history, transient/outage + probes, restart recovery, `kanban restart prepare|recover`, `kanban task resume|send|restart-fresh` | P4-1, P1-5, P3-3 |
| P4-7 | Watchdog: stalls, ATTENTION.md, orchestrator wake (headless/sidebar, lock, `--when-*`), pid pressure, prune-done, daily price check, stuck-on-prompt detection (d84bc part 2), `kanban board prune-done|restore` | P4-1 |
| P4-8 | `scripts/pipeline-shadow-diff.ts` + `docs/team/{WORKFLOW,RUNBOOK,CONFIG}.md` rewritten | P4-2…P4-7 |

P4-2 and P4-7 can run in parallel right after P4-1. P4-3, P4-4 and P4-6 can also run in parallel after P4-1.

**Phase 5: cutover (orchestrator + user, one card each)**

| Card | Scope | Depends on |
|---|---|---|
| P5-1 | Shadow day on foo; fix the differences (new cards as needed) | P4-8 |
| P5-2 | Switch foo to `pipeline.mode: "on"`, kit services disabled, config imported, state copied; one full card cycle watched | P5-1 |
| P5-3 | Retire the kit repo: `kanban` board emptied and unregistered, final tarball, code removed, data moved, bashrc/CLAUDE.md, the user's settings.json step; `forks/` gone (P0-2b) and the `local-forks/*` refs deleted | P5-2, P0-2b, P0-3 |
| P5-4 | Home move in a restart window (`kanban home migrate`, pod `KANBAN_HOME`); `kanban doctor` clean | P5-3, P1-2 |

## 12. Decisions for the user

1. **Pipeline process model** (§5): the pipeline and watchdog as a supervised worker child of the server
   (recommended: fixes reload without killing cards, like `kit start --reload-if-changed` today), or fully
   in-process (simpler, but every fix needs a container restart).
2. **Landing model** (§4.2): a new auto-review mode `qa` where Kanban itself squash-lands onto the base after a
   QA PASS (the agent never commits), landing **before** the card goes to Done. Manual "move to Done" asks
   "land or discard?" instead of landing silently. `commit`/`pr` stay for boards without QA. Confirm that the
   runtime may write the base branch (including stash + `merge --squash` in a checked-out base).
3. **Home default and history** (§6.1, §10): the fork defaults to `~/.kanban` for fresh installs and keeps
   detecting a legacy `~/.cline/kanban`. Running worktrees are never moved. The kit's history goes in as an
   orphan `archive/devteam-kit` branch (not a subtree in fork/stack), pushed only after the exact-value secret
   scan you have to run.

Smaller choices, with defaults already taken in this doc:

- interrupted cards are never auto-trashed;
- the browser stops moving columns;
- `qa-servers.sh` and the `dev-servers.md` rule move to the foo project;
- the image ships the Chromium libs;
- the port cards on `kanban-2uge` are QA-gated by the current kit (decided 20:5xZ: /projects/kanban is a kit
  workspace, base fork/stack).
