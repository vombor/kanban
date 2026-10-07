# Folding the dev-team kit into the fork: design

Status: design only (card 1001c, 2026-10-06; revised by card c6d09 the same day to split the **core** from the
**routing kits**). Phase 0 and Phase 1 cards are landed or in flight (§11). Phase 2 cards don't exist yet, and
nothing from Phase 2 on is implemented.
Inputs: the kit at `/root/.kanban` (main `cc6ef30`, 117 commits), and
this fork at `fork/stack` `67cac3a5` when the design was first written, now `6d83dbdf` (0.1.70-fork.3: upstream main + #592 + #643 + #613/#615/#618 + #611 +
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

The kit's autoland mixes two concerns. The port separates them (user decision 2026-10-06, §4.0):

- **Core** (built into the fork, the same for every project, agent-agnostic): the mechanics. That covers landing
  modes, landing, snapshots, the QA gate, the rework loop and its limits, session sync, recovery, the watchdog and
  input delivery. The core resolves a card's **effective agent** and never makes a routing decision itself.
- **Routing kits** (one per project, pluggable, declarative): the policy the core asks for. Which agent and model
  a new dev card gets; whether a card needs QA, and with which agent, model and prompt; what happens after a FAIL.
  There are two built-in kits: **`default`** (every project, including new ones: Kanban's selected agent, no QA,
  no rework automation) and **`team`** (foo's junior/senior/QA routing as a preset, plus the scoreboard, bench,
  calibration and model tiers that score its routing decisions).

## 1. Names

"Kit" changes meaning. Up to now it meant the `~/.kanban` repo; this document calls that the **legacy kit**
(its history becomes `archive/devteam-kit`). From the port on, **kit** means a **routing kit**: the per-project
policy file that `kanban kit …` manages.

### 1.1 Core features (built in, every project)

| Kit name | New name | Where it lives |
|---|---|---|
| "the kit", "dev-team kit", `~/.kanban` repo | **legacy kit**. Its mechanics become the **pipeline** plus **watchdog**; docs say "team workflow" | `src/pipeline/`, `docs/team/` |
| `kanban-autoland` service, mechanics part | **pipeline** (`src/pipeline/engine.ts`). Its stages: **snapshot**, **checks**, **QA gate**, **land**, **rework loop**, **recovery** | runtime (worker, §5) |
| `projects[]` + toggles `AUTO_DONE`/`QA_CREATE`/`AUTO_REWORK` | **landing mode** per project: `off` \| `commit` \| `pr` \| `qa` (`workspaces.<id>.landing.mode`) | config |
| "is this a dev card?" (`agentId !== "claude"`, title regexes) | **effective agent** (`resolveEffectiveAgent()`, §4.0) and card **`role`** (`dev` \| `qa` \| `triage` \| `calibration`) | `src/core/effective-agent.ts`, card field |
| `kanban-column-sync` service | **session sync** (`src/server/session-column-sync.ts`) | runtime |
| `review-watch` service | **watchdog** (`src/pipeline/watchdog.ts`) | runtime (worker) |
| "the orchestrator" (`__home_agent__:<ws>:claude`) | **orchestrator** = the Kanban **selected agent** (`selectedAgentId`) in that workspace's sidebar. Never a hard-coded id | runtime |
| `model-lists` service (:13306) | **model-lists route** `GET /api/model-lists/lemonade` on the Kanban server | runtime |
| `kit <cmd>` | `kanban <group> <cmd>` (table in §2.3) | `src/commands/*.ts` |
| `kit.config.json` | `$KANBAN_HOME/config.json`: core keys `pipeline.*`, `watchdog.*`, `orchestrator.*`, `models.*`, `agents.*`, `workspaces.<id>.*` (§3.1) | `src/config/` (zod) |
| `checks-state.json` (`qaflow`) | `data/<ws>/pipeline-state.json` (same per-card shape, versioned) | data |
| `KANBAN_KIT_HOME`, `KIT_CONFIG`, `KIT_PROJECT` | `KANBAN_HOME`, `--home`, `--workspace` | |
| `<!-- kanban-kit:begin agents-qa … -->` | `<!-- kanban:managed begin agents-qa -->` (sync reads both for one release) | |
| `kanban-autoland@localhost` snapshot identity, "Landed by kanban-autoland" | `kanban@localhost`, "Landed by Kanban from task <id>" | |
| `run/<svc>.disabled` off switches | `kanban pipeline pause|resume [--workspace]` (persisted setting `pipeline.paused`) | config |
| `AUTOLAND_DRY_RUN` etc. | `workspaces.<id>.pipeline.shadow: true` (decide and log, act on nothing) | config |

### 1.2 Routing kits (one per project)

| Kit name | New name | Where it lives |
|---|---|---|
| (none: every project inherited the top-level `devAgent`/`qaAgent`/toggles) | **routing kit**, referenced per project as `workspaces.<id>.kit = { name, overrides }` | config |
| upstream behaviour, `kanban-2uge` today | built-in kit **`default`** | `kits/default.json` (repo) |
| foo's routing: `devAgent`, `qaAgent`, `qaRoutes`, `PROMPT_RULES`, escalation, runoffs, `benchmark.*` | built-in kit **`team`** | `kits/team.json` (policy) + `src/kits/team/` (its built-in features) |
| user-written routing | **user kit** (data only) | `$KANBAN_HOME/kits/<name>.json` |
| `bench/*`, `qa/calibrate.mjs`, `scoreboard.jsonl`, `runoffs.json`, `benchmark.tiers` | **team-kit features** `scoreboard`, `bench`, `runoffs`, `calibration`, `tiers` | `src/kits/team/` |
| `kit init` / `kit config --project` | `kanban project add --kit <name>`, `kanban kit list|show|apply` | `src/commands/kit.ts` |

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

Legend for the **Owner** column (the §4.0 boundary):

- **core** = built into the fork, the same for every project, agent-agnostic
- **kit** = policy data in a routing kit (`default` answers "no" for all of it; `team` carries foo's values)
- **team** = a built-in feature of the `team` kit (repo code in `src/kits/team/`, on only where a project's kit
  lists it)
- **–** = deleted, archived or plain data

### 2.1 Services

| Component | What it does today | Fate | Owner | New name |
|---|---|---|---|---|
| `services/kanban-autoland.mjs` (2392 lines) | fs.watch on board.json. Covers: snapshots, scripted checks, QA create/queue/slots, verdict ingest, PASS → merge-tree → `task done` → squash-land, rework, nudges, premature-stop, transient/outage probes, escalation, runoffs, restart recovery, board backups, approve marker, syncBase, qaPreview | **R**, split by feature (§2.6) | core (mechanics) + kit (QA routing, onFail policy) + team (scoreboard, runoffs) | pipeline |
| `services/kanban-column-sync.mjs` | Browser-less copy of the UI's session→column moves, plus Cline-CLI "turn ended" heuristics (idle final reply, STATUS line, no-images after 2 min, 5 quiet min after a bounce). Never copies interrupted→trash. In flight: bc84c `988dc45` sends `hooks.ingest to_review` before moving | **R** | core | session sync (generic) + cline-cli turn detector (adapter) |
| `services/review-watch.mjs` | 60 s tick: restarts services, stall detection (review/QA/idle), dead-session continue, ATTENTION.md, orchestrator wake (headless/sidebar), TRIAGE cards, pid pressure/brownout, hourly prune-done, daily price sync. In flight: d84bc `3359bff` adds PRETRUST and "stuck on trust/permission prompt" | **R** | core; the daily price sync is a team job (`bench`) | watchdog |
| `services/model-lists.mjs` | 127.0.0.1:13306 proxy of Lemonade's model list filtered to `tool-calling` | **R** (an HTTP route; one process less) | core | model-lists route |
| `services/ensure.sh` | `kit start --quiet` | **D** (nothing left to start) | – | |
| `services/kanban-runtime.mjs` | tRPC client: `sendChatMessage` (PTY typing + delivery check), `moveCard` (saveState with expectedRevision) | **D** in-process. The delivery check is ported into the runtime (§4.4) | core | `deliverTaskInput()` |

### 2.2 lib/

| Module | Fate | Owner | Notes |
|---|---|---|---|
| `config.cjs` | **D**, replaced by zod config + `kanban-home.ts` + the kit resolver | core | Precedence env > project > top > default becomes: project kit overrides > kit > core default (§3.4). There is no top-level routing any more for a project to inherit. Env stays only for tests |
| `service.cjs` (registry, pidfiles, kit HEAD warning, `/proc` scans, `killUnder`) | **D**, except `killUnder` → `src/pipeline/process-tree.ts` | core | No services, no kit HEAD. The package version is the version |
| `kanban-cli.cjs` (`kanban --version` flavour, `devAgent()` per fork) | **D** | – | In-process there is only one Kanban |
| `card-model.cjs` (`agentSettings ?? clineSettings`, `isClineFamily`) | **D** → `src/core/effective-agent.ts` (`resolveEffectiveAgent`, `resolveEffectiveModel`) | core | The incident fix (§4.0): every decision uses the effective agent, never `card.agentId` |
| `calibration.cjs` (kit `0a894c5`: QA-CAL title, prompt or state-file id) | **D** → card `role: "calibration"` | core | Title and prompt regexes go away with `role` |
| `cline-session.cjs` (Cline 3.x session dirs by worktree, `alive`, `supersedes`, `repeats`, `NO_IMAGES`) | **R** | core | `src/terminal/cline-session-files.ts` |
| `cline-hooks.cjs` (tail `~/.cline/data/logs/hooks.jsonl`, `parseStatus`) | **R** | core | Prefer Kanban's own hook ingest (`hooks-api.ts` already sees every cline-cli hook). Keep the jsonl reader only for `agent_error` text |
| `copilot-session.cjs` (`signedIn()` JSONC, session by worktree) | **R** | core | `src/terminal/copilot-session.ts`. Shares the JSONC parser with the trust-folder fix (§7.2) |
| `providers.cjs` | **C** | core | `kanban models providers` (the core needs it to start any card on a model) |
| `aws-prices.cjs` | **C** | team (`bench`) | `src/kits/team/bench/aws-prices.ts` (pure) |
| `resume.mjs` (`tagWip`, `resumeCard`) | **R** + **C** | core | `kanban task resume` |
| `restart-recovery.mjs` | **R** | core | The server knows its own start time, so the `/proc` btime scan goes away |
| in flight: `agent-trust.cjs`, `prompt-watch.cjs` (d84bc) | **R** | core | §7.1 |
| `qa-route.cjs` (3c292) | **D** as code: `qaRoutes` become `team` kit data (`qa.routes`), evaluated by the core's kit resolver | kit | `devModelOf()` (a Cline card without a model counts as the Cline CLI default) becomes core `resolveEffectiveModel()` |

### 2.3 bin/ and the `kit` CLI → `kanban` subcommands

| Kit command or script | New command | Fate | Owner |
|---|---|---|---|
| `kit init <path>` | `kanban project add <path> [--kit <name>] [--landing off|commit|pr|qa] [--base B] [--blurb …] [--agents-md]`. Without `--kit` the project gets `default` and landing `off` | **C** | core |
| (none) | `kanban kit list`, `kanban kit show <name> [--project <ws>]` (the resolved policy with each value's source), `kanban kit apply <name> [--project <ws>] [--landing off|commit|pr|qa] [--set key=value …] [--unset key]` (`--landing` also sets the core landing mode; without it the mode is left alone) | **C** (new) | core |
| `kit sync <path>` | `kanban project sync <path> [--dry-run]` (managed sections) | **C** | core |
| `kit check [path] [--fix]` | `kanban doctor [path] [--fix]` (fast, read-only unless `--fix`, exit 0). Also prints each project's kit and landing mode | **C** | core |
| `kit switch-check` (`post-switch-check.mjs`) | folded into `kanban doctor --deep` (agent CLIs, env, ssh mode, providers). Its "default agent is not claude" warning is **D**: the orchestrator is whatever agent is selected | **C** | core |
| `kit machine-setup` | `kanban setup [--dry-run]`: npmrc, Cline rules, providers.json entries, Claude/Codex trust, the `~/.claude/CLAUDE.md` managed section. No bashrc, no prompt-template override | **C** | core |
| `kit start|stop|status` | `kanban pipeline status|pause|resume` (plus `restart` if the pipeline runs as a worker, §5) | **C** | core |
| `kit config` | `kanban config show [--workspace]`, `kanban config import-kit <kit.config.json>` (maps each project to a kit, §3.5) | **C** | core |
| `kit handback` | `kanban task handback <id> --note … [--extra-rounds N]` | **C** (in-process: no stop/start dance) | core |
| `kit prepare-restart` | `kanban restart prepare [--dry-run]` | **C** | core |
| `kit recover-restart` | `kanban restart recover [--dry-run]` | **C** | core |
| `kit probe-models` | `kanban models probe <id…>` (`--list`; the `--openai` Mantle probes are **D**) | **C** | core (outage recovery uses it) |
| `kit providers` | `kanban models providers [--for M] [--cleanup] [--migrate-cards]` | **C** | core |
| `bin/resume-card.mjs` | `kanban task resume <id…>` | **C** | core |
| `bin/chat-card.mjs` | `kanban task send <id> <text|@file>` (uses `deliverTaskInput`) | **C** | core |
| `bin/approve-card.mjs` + `bin/commit-mode.mjs` + the `KANBAN-HUMAN-APPROVED` marker | **R**: on a `qa`-mode card the Commit button becomes **Approve & land** (runtime land action). CLI: `kanban task approve <id>` | **R**/**C**. The prompt-marker hack is **D** | core |
| `bin/orchestrator-wake.mjs` | **R** (watchdog launches it) + `kanban orchestrator wake <issue>`. Target: the selected agent's sidebar session `createHomeAgentSessionId(ws, selectedAgentId)`; headless mode only if that agent's adapter has a headless runner (`claude -p`, `codex exec`), else sidebar mode | **P** for the run itself: a headless run is an agent run, launched by the runtime under a lock and timeout | core |
| `bin/wake-when.mjs` | `kanban orchestrator wake --when-card-done <id> | --when-model-up <m>` (a watchdog timer, no detached poller) | **R**/**C** | core |
| `bin/prune-done.mjs` | watchdog job + `kanban board prune-done [--days N] [--dry-run]` | **R**/**C** | core |
| `tools/restart-fresh.mjs` | `kanban task restart-fresh <id> --model … --label …` | **C** | core |
| `tools/recovery/restore-board.sh` | `kanban board restore <ws> [backup]` (Kanban stopped, or through the state API) | **C** | core |
| `tools/recovery/rebuild-board.mjs` | one-off from the 10/04 incident | **A** | – |
| `tools/migrate-legacy-home.sh` | done (10/05) | **A** | – |
| `tools/diagnostics/kanban-flowtrace.mjs` | logpoints at line numbers of the 0.1.70 dist | **D** | – |
| `tools/diagnostics/kanban-freeze-monitor.sh`, `sidebar-freeze-catch.sh` | `scripts/diagnostics/` in the repo (dev tools, not product) | **C**-adjacent: repo scripts | – |

### 2.4 qa/, bench/, probes/

| Component | Fate | Owner | New |
|---|---|---|---|
| `qa/qa-card.cjs` (QA v4 prompt, round count, `task create … --auto-review-enabled false`) + `qaRoutes` | **R**, split | core: prompt skeleton (snapshot, scratch copy, outbox, verdict contract, round), QA card creation; kit: agent/model/route, `rules` texts (`drive`), blurb, `promptNotes` | `src/pipeline/qa-prompt.ts` (assembles kit prompt parts into the skeleton), `qa-cards.ts`. Cards get a real `role: "qa"`, `reviewsTaskId` field instead of prompt/title regexes |
| `qa/qa-servers.sh` (Pawsome-specific) | **DATA**: a per-workspace script, referenced by foo's kit override `qa.serversScript: "data/foo/qa-servers.sh"` | kit (project override) | |
| `qa/qa-shot.cjs` (Playwright screenshots) | **C**: `kanban qa shot …` (run by QA agents in their scratch copy) | core (any kit's QA can use it) | |
| `qa/calibrate.mjs` | **C**+**P**: `kanban bench calibrate <spec>` (long job, detached, resumable state in `data/<ws>/calibration/<name>/`) | team (`calibration`) | Separate process because a run lasts hours and must survive a pipeline reload |
| `bench/record-verdict.cjs` | **R**, split: the core records the verdict (pipeline-state, qa-log); the team `scoreboard` feature appends the scoreboard line on the `verdictRecorded` event. `kanban bench record-verdict` for humans | core + team | |
| `bench/card-metrics.cjs` | **R** + `kanban bench metrics <id>` | team (`bench`) | `src/kits/team/bench/card-metrics.ts` |
| `bench/scoreboard.cjs` | **C**: `kanban bench scoreboard` | team (`scoreboard`) | |
| `bench/snapshot-reset.mjs` | **C**: `kanban bench reset <label>` | team (`bench`) | |
| `bench/sync-prices.mjs` | **C** + a daily `--check` job (the watchdog runs registered feature jobs): `kanban models prices sync [--apply|--check]` | team (`bench`) | |
| `bench/prices.json` | **DATA** → `data/prices/prices.json` (package ships `assets/prices.default.json` as the seed) | team | |
| `bench/prices-aws.json` (154 KB, generated) | **DATA** → `data/prices/prices-aws.json`. Filtered out of the imported history | team | |
| `bench/model-prices.md` (hand-written price sources) | **DATA** → `data/prices/model-prices.md` | team | |
| `bench/backfill-scoreboard.cjs` | one-off Pawsome backfill | – | **A** |
| `probes/bedrock-converse-probe.mjs` | **C**: `kanban models probe` (also used by outage recovery) | core | |
| `probes/mantle-*.mjs` | deprecated openai-native path | – | **D** |

### 2.5 machine/, templates/, shell/, home files

Everything in this table is **core** (machine setup), except `dev-servers.md`, which is a foo project file.

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

| Feature | Fate | Owner | Overlaps with the runtime? |
|---|---|---|---|
| Board watching (fs.watch, debounce, startup sweep) | **R**: subscribe to the in-process state hub (`broadcastRuntimeWorkspaceStateUpdated`) | core | Replaces disk polling |
| "Is this a dev card?" (`agentId !== "claude"`, `NOT_DEV_TITLE`, `isClineFamily`, calibration predicate) | **D** → `role` + `resolveEffectiveAgent()`. Whether a card gets QA is the kit's `qaPolicy` answer | core (resolve) + kit (decide) | The reconciler already uses `card.agentId ?? selectedAgentId` (`auto-review-reconciler.ts:435`) |
| Snapshots `refs/kanban/snapshots/<id>` (temp index, commit-tree) | **R** `src/pipeline/snapshots.ts` | core | The reconciler's git probe; reuse its worktree helpers |
| Scripted checks (git archive → npm ci → `CHECK_SCRIPTS`) | **R** (child processes, serial queue) | core (scripts per project in core settings) | none |
| QA create/queue/`qaSlots`, QA preview start/stop | **R** | core | none |
| QA agent/model choice (`qaAgent`, `qaRoutes`, vendor rule), QA prompt rules and notes, which cards skip QA | **R** as kit data | kit | none |
| Verdict outbox ingest (`/tmp/qa-out/<qa>/verdict.json`) → qa-log, artifacts, QA card to Done | **R** | core | none |
| Scoreboard line per verdict, per-model metrics | **R** as a feature on the `verdictRecorded` event | team (`scoreboard`) | none |
| PASS: pre-done snapshot, `merge-tree` pre-check, land | **R**, as landing mode `qa` | core (kit `onPass` may hold) | **Yes**: auto-review commit mode (§4.2) |
| Squash-land (`commit-tree`+`update-ref` or `merge --squash` in the checked-out base) + `postLand` | **R** `src/workspace/land.ts` | core (the `postLand` commands are kit/project data) | **Yes**: agent-driven commit (§4.2) |
| FAIL → rework (prompt section, `.qa/r<N>/`, `/clear` thresholds, typed delivery, 2-min started-check) | **R** | core (machinery, limits); kit (`onFail`: rework or not) | Delivery: §4.4 |
| Merge conflict = FAIL | **R** | core | |
| Escalation mechanics (`BLOCKED:` + backlog, ESCALATE section, ATTENTION.md, TRIAGE card, sibling card on another model), handback | **R** + `kanban task handback` | core | |
| Escalation policy: after how many FAILs, to the orchestrator or to a senior tier | **R** as kit data | kit | |
| Lemonade "one model loaded" rework hold (kit `a01625e`) | **R** as provider capacity `models.providerCapacity.lemonade.maxLoadedModels: 1` | core | |
| Crash nudges, premature stop, poisoned history (/clear + resend), no-images, overflow cleanup, hung-request cancel (`f9ed1c3`) | **R** `src/pipeline/recovery.ts` | core | Session states come from the runtime state machine |
| Transient retry, outage hold, model probes | **R** (probe in-process) | core | |
| Restart recovery (orphans, manifest, WIP tags, `startTaskSession`) | **R** | core | **Yes**: shutdown cleanup (§4.5) |
| Runoffs: hold a PASS | **R** as the core **hold** (`onPass → hold`, `releaseHold(card, "land" \| "discard")`) | core | |
| Runoffs: groups, decide (score, then FAIL rounds, then cost), preserve tags, delete losers, `benchOnly` | **R** | team (`runoffs`) | |
| Board backups (`board-latest.json`, every 10 min, 200 kept) | **R**: in `mutateWorkspaceState`'s write path (every write, not every watch event) | core | |
| `syncBase` (detach a clean stale worktree onto the base tip at start) | **R** in the task-start path | core | |
| Approve marker (`KANBAN-HUMAN-APPROVED`) | **D** → Approve button | – | |
| Kit HEAD warning | **D** | – | |

## 3. Settings (old key → new key)

All keys live in `$KANBAN_HOME/config.json`. Today's global keys (`selectedAgentId`, `commitPromptTemplate`, …)
stay where they are. There are two schemas:

- **Core settings** (`src/config/pipeline-config.ts`, zod): machine-wide mechanics, plus per-workspace mechanics
  under `workspaces.<id>.*`. They never name an agent or a model for a card.
- **Kit schema** (`src/kits/kit-schema.ts`, zod): the routing policy. A kit is a JSON document. A workspace
  references one by name and may override single keys (§3.4).

### 3.1 Core settings

| kit.config.json | New key | Default |
|---|---|---|
| `projects[]` (the list of handled workspaces) | every registered workspace is handled; what happens is `workspaces.<id>.landing.mode` + its kit | `"off"` + kit `default` (boards behave like upstream, §3.3) |
| `toggles.AUTO_DONE` | `workspaces.<id>.landing.mode` (`off` \| `commit` \| `pr` \| `qa`): `qa` = Kanban lands after the gate; `commit`/`pr` = upstream auto-review; `off` = the orchestrator or the user lands | `off` |
| `AUTOLAND_DRY_RUN` | `workspaces.<id>.pipeline.shadow` (decide and log, act on nothing) | false |
| `projects[].baseBranch` | `workspaces.<id>.defaultBaseRef` (a card's `baseRef` wins) | detected |
| `projects[].name` | `workspaces.<id>.name` | repo dir name |
| `projects[].scoreboard`, `qaLog`, `state`, `attention`, … | fixed: `data/<id>/…` (no per-file overrides; the team `scoreboard` feature writes `data/<id>/scoreboard.jsonl`, and foo's `bench/scoreboard.jsonl` moves up one level at P5-2) | |
| `qaSlots` | `pipeline.qa.slots` (machine-wide capacity) | 2 |
| `QA_TIMEOUT_MIN`, `QA_NUDGE_MAX`, `QA_VERDICT_GRACE_MS` (env) | `pipeline.qa.timeoutMin`, `.maxNudges`, `.verdictGraceSec` | 60, 2, 20 |
| `qaScratchRoot`, `qaOutRoot`, `chromiumLibs` | `pipeline.qa.scratchRoot`, `.outboxRoot`, `.chromiumLibs` | /tmp/kanban-qa, /tmp/kanban-qa-out, null (image libs) |
| `checksRoot`, `CHECKS`, `CHECK_SCRIPTS`, `CHECK_TIMEOUT_MIN`, `CHECK_ALLOW_SCRIPTS` | `pipeline.checks.{scratchRoot,timeoutMin,allowScripts}`; per workspace `workspaces.<id>.checks.{enabled,scripts}` | /tmp/kanban-checks, 15; enabled only when landing is `qa`, [typecheck,lint,test,build] |
| `QAFLOW_MAX_FAILS` | `pipeline.rework.maxFailRounds`: the hard cap. A kit's `onFail` decides below it; at the cap the core escalates whatever the kit says. `kanban task handback --extra-rounds N` raises it for one card | 3 |
| `REWORK_CLEAR_TURNS`, `REWORK_CLEAR_TOKENS` | `pipeline.rework.clearAfterTurns`, `.clearAfterTokens` | 100, 150000 |
| `NUDGE_MAX`, `PREMATURE_MAX`, `TRANSIENT_BACKOFF_MIN`, `HUNG_MIN`, `HUNG_FIRST_MIN` | `pipeline.recovery.maxNudges`, `.maxContinues`, `.retryBackoffMin`, `.hungMin`, `.hungFirstMin` | 2, 8, [1,2,4,8], 15, 30 |
| `OUTAGE_PROBE_MIN`, `OUTAGE_UPS`, `OUTAGE_MAX_MIN` | `pipeline.recovery.outage.{probeEveryMin,upsToResume,maxMin}` | 5, 2, 360 |
| (none) | `workspaces.<id>.recovery.enabled` (nudges, outage holds, restart recovery) | true (§12, smaller choices) |
| `toggles.TRIAGE_CARDS` | `watchdog.triageCards` (TRIAGE cards run on the selected agent) | false |
| `WATCH_INTERVAL_SEC`, `STALL_REVIEW_MIN`, `STALL_QA_MIN`, `STALL_IDLE_MIN`, `RESUME_IDLE_MIN`, `NEW_CARD_GRACE_MIN`, `PROMPT_STUCK_MIN` | `watchdog.intervalSec`, `.stall.{reviewMin,qaMin,idleMin,resumeIdleMin,newCardGraceMin,promptMin}` | 60, 10, 45, 30, 5, 10, 3 |
| `TRIAGE_COOLDOWN_MIN` | `watchdog.triageCooldownMin` | 120 |
| `PID_PRESSURE`, `PID_BROWNOUT` | `watchdog.pids.{pressure,brownout}` | 0.75, 0.9 |
| `toggles.PRUNE_DONE`, `PRUNE_DONE_DAYS` | `watchdog.pruneDone.{enabled,days}` | true, 3 |
| `toggles.WAKE_ORCHESTRATOR`, `wakeMode`, `WAKE_COOLDOWN_MIN`, `ORCH_TIMEOUT_MIN`, `ORCH_LIVE_MIN` | `orchestrator.wake.{enabled,mode,cooldownMin,timeoutMin,liveSessionMin}`. There is **no** `orchestrator.agent`: the target is always `selectedAgentId` | true, "headless" (falls back to "sidebar" when the selected agent has no headless runner), 30, 45, 10 |
| `toggles.PRETRUST` | `agents.pretrust` | true |
| `providers` (`default`, `fallback`, `legacyUpstream`, `deprecated`) | `models.providers.{default,fallback,deprecated}` (`legacyUpstream` **D**) | bedrock |
| (code in autoland `a01625e`) | `models.providerCapacity.<id>.maxLoadedModels` (P3-1 key; P3-2's import mapping uses it. Merged over the defaults, so setting one provider keeps `lemonade: 1`. Rework/start waits while another card holds a different model on that provider) | lemonade: 1 |
| `bedrockRegion` | `models.bedrockRegion` | us-west-2 |
| `modelLists` | `models.lists.lemonade.{url,requireLabels}` | http://localhost:13305, ["tool-calling"] |
| `BOARD_BACKUP_MIN`, `BOARD_BACKUP_KEEP` | `backups.board.{everyMin,keep}` | 10, 200 |
| `kanbanUrl`, `runtimeUrl`, `kanbanCli`, `syncIntervalSec`, `logs.*`, `runDir`, `dataRoot`, `pricesDir`, `boardBackupDir` | **D**: in-process, or a fixed path under `KANBAN_HOME` | |
| `kanbanHome`, `worktrees` | `KANBAN_HOME`, `worktreesRoot` (§6) | |
| `clineSessions`, `codexSessions`, `clineProviders` | `agents.cline.dataDir`, `agents.codex.home` | ~/.cline/data, ~/.codex |

Keys the P3-1 schema did not have, added by P3-2:

- **`wakeTarget`** (legacy kit `00514f2`, `lib/sidebar-wake.cjs`): one workspace id whose sidebar gets the wakes of
  every watched workspace (one orchestrator, user 10/06), and the live value `wakeMode: "sidebar"` (the table above
  defaults to `"headless"`). Core key `orchestrator.wake.target` (a workspace id, null = each workspace wakes its
  own sidebar) next to `orchestrator.wake.mode`. P3-2's import maps both; P4-7 (watchdog wakes) reads them.
- **`sessionSync`** (P2-1, a top-level boolean in config.json): now the core section `sessionSync.enabled`
  (default true). The boolean still reads the same; `kanban doctor --fix` and `kanban config import-kit` rewrite it.

### 3.2 Kit schema

Each key answers one of the core's questions (§4.0). A missing key means "no answer", and the core then uses the
`default` column. The schema is versioned (`"kit": 1`) and strict: an unknown key is an error at `kanban kit
apply`, not a silent no-op.

| Kit key | Question | `default` kit (= no answer) | `team` kit | Old key |
|---|---|---|---|---|
| `dev.agent`, `dev.model` (`{ tier }` or `{ provider?, model }`) | `devAssignment` | null: the card keeps what its creator set, else Kanban's selected agent with its own model | `cline`, `{ tier: "tier3" }` (today `us.openai.gpt-6.1-sol`) | `devAgent`, `benchmark.tiers.tier3[].default` |
| `qa.enabled` | `qaPolicy`: does a dev card get QA at all | false | true | `toggles.QA_CREATE` |
| `qa.skip.roles`, `qa.skip.effectiveAgents` | `qaPolicy`: which cards never get QA | – | roles `qa`, `triage`, `calibration`; agents `[]` (§12) | the literal `agentId === "claude"` check (**D**) |
| `qa.default.{agent,model,provider}` | `qaPolicy`: the QA agent when no route matches | – | `codex`, model from `~/.codex/config.toml` | `qaAgent` |
| `qa.routes[]` `{ devModel, agent, model?, provider?, rules?, why? }` | `qaPolicy`: QA by the dev card's effective model, first match wins | `[]` | OpenAI-built (`(^\|\.)openai\.\|^gpt-`) → `cline` + Haiku 4.5, rules `["drive"]` | `qaRoutes` |
| `qa.requireDifferentVendor` | `qaPolicy`: validation; `kanban kit show` and the QA step refuse a route whose QA vendor equals the dev vendor | false | true | user rule 10/06 (prose only today) |
| `qa.rules.<name>` (text) | `qaPolicy`: prompt pieces a route can name | `{}` | `drive` ("log in and drive the changed path, screenshot it") | `PROMPT_RULES` in qa-card.cjs |
| `qa.blurb`, `qa.promptNotes.{screenshotFallback,knownBaseIssues,dbSetup}`, `qa.serversScript`, `qa.preview` | `qaPolicy`: project-specific prompt parts and the preview to start | "" / null | "" / null; foo sets them as overrides | `projectBlurb`, `qaPrompt.*`, `qaPreview` |
| `onFail.rework` | `onFail`: hand a FAIL back to the same card and model | `"none"` | `"same-model"` | `toggles.AUTO_REWORK` |
| `onFail.reworkRounds` | `onFail`: FAIL rounds before escalating (capped by `pipeline.rework.maxFailRounds`) | 0 | 3 | `QAFLOW_MAX_FAILS` |
| `onFail.conflict` | `onFail`: a merge conflict at land time | `"stop"` | `"rework"` (with rebase notes) | autoland rule |
| `onFail.then` `"escalate"` \| `"stop"` | `onFail`: after the rounds run out (or STALLED/DNF/unchanged rework) | `"stop"` | `"escalate"` | autoland rule |
| `escalate.to` `"orchestrator"` \| `{ tier }` \| `{ agent, model }`, `escalate.requireApproval` | `onFail`: who takes an escalated card | `"orchestrator"` | `"orchestrator"`, `requireApproval: true` (tier 2 costs need the user, WORKFLOW §7). `{ tier: "tier2" }` is the opt-in senior tier | (prose: TRIAGE "never decides model or budget") |
| `onFail.runoff` `{ models[] }` \| null | `onFail`: answer a FAIL by racing other models on the same task | null | null (runoffs are started by the orchestrator, `kanban bench runoff create`) | `runoffs.json` (hand-written) |
| `land.postLand[]` `{ paths, run, stopUnder? }` | not a question: commands the core runs after it lands | `[]` | `[]`; foo overrides | `projects[].postLand` |
| `features[]` | which built-in features run for the project | `[]` | `scoreboard`, `bench`, `runoffs`, `calibration`, `tiers` | (always on) |
| `tiers`, `dropped`, `tierRules`, `tierNotes` | data. `dev.model: { tier }` resolves in the P3-1 evaluator (the tier's entry marked `default`, else its first entry; `dropped` models are skipped). `escalate.to: { tier }` and `kanban bench tiers` are the `tiers` feature (P4-T3) | – | foo's `benchmark.*` | `benchmark.*` |
| `prices.{region,autoSync}` | data for the `bench` feature | – | us-west-2, true | `pricesRegion`, `toggles.PRICE_SYNC` |
| `recommends.landingMode` | shown by `kanban kit show/apply`; **never applied** without `--landing` | – | `"qa"` | |

What a kit cannot express, and why it does not have to:

- **Runoff decisions** compare several cards' scores, FAIL rounds and costs. That is code, so it is the team
  `runoffs` feature. The core only offers the hold (`onPass → hold`) and `releaseHold()`.
- **The scoreboard** and **calibration** write files and create cards on events. They are the `scoreboard` and
  `calibration` features.
- Everything else in foo's routing today is data: `devAgent`, `qaAgent`, `qaRoutes` (regex + agent + model +
  rule names), the vendor rule, rework rounds, escalation, `postLand`, `qaPreview`, prompt notes and tiers. The
  regexes inside autoland that decide "is this a dev card" are not routing: `role` and the effective agent
  replace them (§4.0).
- So there are **no code hooks for user kits** in v1. A user kit is data and can switch on built-in features by
  name. A hook API is added only when a real kit needs one.

### 3.3 Built-in kits

`kits/default.json` and `kits/team.json` ship in the package (added to `package.json` `files`). User kits live in
`$KANBAN_HOME/kits/<name>.json`. A user kit with a built-in name is refused.

```jsonc
// kits/default.json: what every project gets, new ones included
{ "kit": 1, "name": "default", "description": "Kanban's selected agent for every card; no QA, no rework automation",
  "qa": { "enabled": false }, "onFail": { "rework": "none", "then": "stop" }, "features": [] }

// kits/team.json: foo's junior/senior/QA routing as a preset
{ "kit": 1, "name": "team", "description": "Cline juniors on tier-3 models, cross-vendor QA, same-model rework, escalation to the orchestrator",
  "dev": { "agent": "cline", "model": { "tier": "tier3" } },
  "qa": { "enabled": true, "requireDifferentVendor": true,
          "skip": { "roles": ["qa", "triage", "calibration"], "effectiveAgents": [] },
          "default": { "agent": "codex" },
          "routes": [{ "devModel": "(^|\\.)openai\\.|^gpt-", "agent": "cline",
                       "model": "us.anthropic.claude-haiku-4-5-20251001-v1:0", "rules": ["drive"] }],
          "rules": { "drive": "…" } },
  "onFail": { "rework": "same-model", "reworkRounds": 3, "conflict": "rework", "then": "escalate" },
  "escalate": { "to": "orchestrator", "requireApproval": true },
  "tiers": { "tier3": [/* … */], "tier2": [/* … */], "qa": [/* … */] }, "dropped": [/* … */],
  "features": ["scoreboard", "bench", "runoffs", "calibration", "tiers"],
  "recommends": { "landingMode": "qa" } }
```

### 3.4 Project → kit, and resolution order

```jsonc
"workspaces": {
  "foo":         { "landing": { "mode": "qa" },  "kit": { "name": "team", "overrides": { "qa.blurb": "Project: Pawsome…", "qa.promptNotes.dbSetup": "…", "land.postLand": [/* … */] } } },
  "kanban-2uge": { "landing": { "mode": "off" } /* no "kit": default */ }
}
```

- A value comes from, first match wins: the workspace's `kit.overrides` (dotted key → value) → the named kit →
  the `default` kit. Arrays are replaced, not merged (as with `qaRoutes` today).
- **Nothing is inherited from another workspace or from a top-level routing key.** No such key exists any more.
  A workspace without a `kit` entry gets `default`. This is the structural fix for the 10/06 incident.
- `kanban kit apply team --project foo` writes `kit.name`, keeps existing overrides, and prints what changes.
  `--set key=value` / `--unset key` edit overrides. `kanban kit show --project foo` prints every resolved value
  with its source (`override` / `team` / `default`).
- Kit files and overrides are read through one resolver (`src/kits/resolve-kit.ts`). The pipeline worker reloads
  them on change, so applying a kit needs no restart (§5).

### 3.5 `kanban config import-kit` (P3-2, used at cutover)

| kit.config.json | Becomes |
|---|---|
| foo entry + top-level `devAgent`/`qaAgent`/`qaRoutes`/`benchmark`/toggles | `workspaces.foo`: kit `team`, landing `qa` (shadow until P5-2). Values that differ from `kits/team.json` become overrides; foo's `projectBlurb`, `qaPrompt.*`, `postLand` become overrides |
| `kanban-2uge` entry with toggles off | `workspaces.kanban-2uge`: no kit (`default`), landing `off` |
| any other project | no kit (`default`), landing `off`. Import never copies top-level routing onto a project |
| `qaSlots`, thresholds, watchdog/orchestrator keys | core settings (§3.1) |

### 3.6 Per card

Per-card: `autoReviewMode` gains `"qa"`, so the type becomes `"commit" | "pr" | "qa"`. A new card takes its
default from the workspace's landing mode (`off` → `autoReviewEnabled: false`; `commit`/`pr`/`qa` → that mode).
The UI and CLI can still override `commit`/`pr` per card as upstream does; `qa` is only offered where landing is
`qa`. QA, TRIAGE and calibration cards get `role` and are never auto-reviewed.

## 4. The core/kit boundary, and the overlap with the runtime auto-review code

### 4.0 Core and routing kits

**The incident this design is built against (2026-10-06).** On `kanban-2uge` the user wanted every card on the
Kanban default agent (Claude), landed by the orchestrator. Autoland skipped only cards whose **literal**
`agentId` was `"claude"` (`isFlowDevCard`, `createQa`). Cards with no `agentId`, which inherit Claude as the
workspace default, counted as Cline dev cards. So autoland QA'd and landed P0-2 and escalated P0-3 and P0-2b
on a board that was meant to be landed by the orchestrator. The second cause: a project entry inherits the
top-level `devAgent`/`qaAgent`/toggles (`lib/config.cjs`), so a new board got foo's routing without asking for it.
Interim fix: per-project toggles `QA_CREATE`/`AUTO_REWORK`/`AUTO_DONE = false` for `kanban-2uge` in kit.config.json,
and every card pinned with `--agent-id claude`.

Rules that follow from it:

1. **The core resolves, the kit decides.** The core never compares an agent id to a constant, and it never
   decides routing.
2. **The effective agent is one function**, `resolveEffectiveAgent(card, summary, config)`, used everywhere: the
   agent the card's session actually ran on (`summary.agentId`), else `card.agentId`, else `selectedAgentId`. The
   same goes for `resolveEffectiveModel()`: the card's settings, else the session's model, else the agent's own
   default (for Cline, providers.json `lastUsedProvider`, as `devModelOf()` does today). Kits see only effective
   values.
3. **No inheritance.** A project without a kit gets `default`, which answers "no" to everything (§3.4).
4. **The orchestrator is the selected agent**, never hard-coded (review-watch today hard-codes
   `__home_agent__:<ws>:claude`).

**What the core owns** (the same in every project): the landing modes `off | commit | pr | qa`; landing (stash +
`merge --squash` before Done) through the single Done workflow (P1-4); snapshots; scripted checks; the QA gate as a
mechanism (create a QA card for a submitted card, ingest its verdict, act on PASS/FAIL); the rework loop machinery
and its limits; the hold; escalation mechanics; session sync; recovery (nudges, restarts, outage holds); the
watchdog (stalls, ATTENTION.md, waking the orchestrator); input delivery (P1-5); and the `verdictRecorded`,
`landed`, `reworkSent`, `escalated` events for kit features.

**What a kit owns** (per project): the answers to the questions below; project QA prompt pieces, `qaPreview`,
`postLand`; which built-in features run. The `team` kit's features (scoreboard, bench, calibration, runoffs,
tiers) score routing decisions, so they belong to the kit, not the core.

**The questions** (`src/kits/policy.ts`). One evaluator in the core answers them from the resolved kit data;
nothing is a plugin.

```ts
type EffectiveCard = {
	card: RuntimeBoardCard;
	workspaceId: string;
	role: "dev" | "qa" | "triage" | "calibration";
	agentId: RuntimeAgentId; // resolveEffectiveAgent()
	model: { provider: string | null; model: string } | null; // resolveEffectiveModel()
};
type CardHistory = { failRounds: number[]; reworks: number; nudges: number; escalations: number; handbacks: number; extraRounds: number };

interface RoutingPolicy {
	// At card creation, only when the creator set no agent/model. null = leave it (the card runs on the selected agent).
	devAssignment(input: { workspaceId: string; title: string; prompt: string; role: "dev" }):
		| { agentId: RuntimeAgentId; model?: { provider: string | null; model: string } }
		| null;
	// When a dev card is submitted (Review with work, landing mode qa).
	qaPolicy(input: { dev: EffectiveCard; round: number; history: CardHistory }):
		| { kind: "none"; reason: string }
		| { kind: "qa"; agentId: RuntimeAgentId; model: { provider: string | null; model: string } | null;
		    route: string | null; promptParts: { rules: string[]; blurb: string; notes: QaPromptNotes; serversScript: string | null } };
	// After a FAIL verdict, a merge conflict at land, STALLED/DNF, or a rework that came back unchanged.
	onFail(input: { dev: EffectiveCard; cause: "fail" | "conflict" | "stalled" | "unchanged"; verdict: Verdict | null;
	                history: CardHistory; limits: { maxFailRounds: number } }):
		| { action: "rework"; clearContext: "auto" | "always" | "never" }
		| { action: "escalate"; to: "orchestrator" | { agentId: RuntimeAgentId; model: { provider: string | null; model: string } }; requireApproval: boolean; reason: string }
		| { action: "runoff"; models: { agentId: RuntimeAgentId; provider: string | null; model: string }[] }
		| { action: "stop"; reason: string };
	// After a PASS, before land. Only the team `runoffs` feature answers "hold".
	onPass(input: { dev: EffectiveCard; verdict: Verdict }): { action: "land" } | { action: "hold"; group: string };
}
```

| Question | Called by | Default when the kit has no answer | Core guarantees around it |
|---|---|---|---|
| `devAssignment` | `task create` (CLI, UI, tRPC) when the creator set no agent (P3-5) | `null` | An explicit `--agent-id`/model always wins. The UI shows the proposed agent before creating |
| `qaPolicy` | the QA gate, once per submitted snapshot | `none` | Never asked for `role != "dev"`. With landing `qa` and the answer `none`, the card **waits for Approve & land** (nothing lands without a verdict or a human) |
| `onFail` | the rework loop | `stop`: the card stays in Review, one ATTENTION.md line, the orchestrator is woken | At `pipeline.rework.maxFailRounds` (+ handback rounds) the core escalates to the orchestrator whatever the kit says. `rework` is refused (→ `escalate`) when the agent's adapter can't resume on the same model. `requireApproval` puts the card in Backlog `BLOCKED:` until the orchestrator or the user acts |
| `onPass` | the land step | `land` | A held card stays in Review with its PASS recorded. `releaseHold(card, "land" \| "discard", { tag })` is the only way out |

What the core does with each answer: `rework` → the REWORK section, typed delivery, the `/clear` thresholds and
the started-check (unchanged from autoland). `escalate` to the orchestrator → `BLOCKED:` + backlog, ESCALATE in
the QA log, ATTENTION.md, a wake. `escalate` to a model → the work is kept as `preserve/<id>-<model>`, and a
linked sibling card is created on that model with the prompt plus the QA notes; the original goes to Backlog
`BLOCKED:`. `runoff` → sibling cards in a group, then the `runoffs` feature decides. `stop` → nothing more.

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
- `commit`/`pr` modes stay unchanged for projects with landing `commit`/`pr`. Landing `off` arms nothing: the
  orchestrator or the user lands (the `default` kit's behaviour, and `kanban-2uge`'s).
- The landing mode is a **core** setting, separate from the kit. `qa` asks the kit's `qaPolicy` for each
  submitted card. If the answer is `none` (the `default` kit), the card waits for Approve & land. Applying a kit
  never changes the landing mode; `kanban kit apply team --landing qa` does both in one step on purpose.
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

`--skip-shutdown-cleanup` becomes the default when any workspace has landing `qa` or recovery on, so the image no
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

The split from §4.0 changes the worker in three ways:

- The kit resolver and the team-kit features (`src/kits/team/`) run **in the worker**, next to the pipeline. A
  routing fix is then a worker reload.
- A **policy change is data**: `kanban kit apply` or editing a kit file is picked up when the worker sees the
  config change, with no reload at all.
- The server keeps only what it needs to create cards: `devAssignment`, through the same resolver module.
  `resolveEffectiveAgent` is server code, because session sync, the UI and the reconciler use it too.

## 6. Kanban home

### 6.1 Resolution (`src/state/kanban-home.ts`, the only place that knows paths)

1. `kanban --home <dir>`
2. `KANBAN_HOME`
3. `~/.kanban` of the user running Kanban (root or node)

There is no legacy step and no fallback (since P5-4, 10/07): `~/.cline` is the Cline CLI's, Kanban keeps nothing
there and never switches homes because a directory exists. A path Kanban needs and can't find is an error that says
where it looked.

- Worktrees: `worktreesRoot` (config) or `KANBAN_WORKTREES`, default `<home>/worktrees`.
- `legacyWorktreeRoots` (default: none) is searched read-only when a task's worktree is not in the home's root, only
  for roots config.json lists (`kanban home migrate` writes the old home's). Live worktrees are never moved; they
  drain as their cards finish (§8.3), then the entry is removed. `kanban doctor` warns while an entry exists and
  about any Kanban home, board, state file or task worktree under `~/.cline`.
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
  kits/<name>.json                 user routing kits (built-in default/team ship in the package)
  workspaces/index.json            Kanban board state (was ~/.cline/kanban/workspaces; internal layout unchanged)
  workspaces/<id>/{board,sessions,meta}.json
  hooks/<agent>/                   was ~/.cline/kanban/hooks
  trashed-task-patches/            was ~/.cline/kanban/trashed-task-patches
  worktrees/<taskId>/<repo>/       task worktrees (a home move's leftovers: legacyWorktreeRoots, until done)
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
| `7d08918` qaRoutes (was 3c292 `22557f3`) | QA model by dev vendor (OpenAI-built cards → Haiku 4.5 on Cline + "drive the changed path") | P3-1 (`team` kit `qa.routes`), P4-T1 (`team-qa-routing.test.ts`) |
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
  - `kanban-2uge` (/projects/kanban, base fork/stack): the port cards. It has been a kit workspace since 20:5xZ.
    After the 10/06 incident (§4.0) its toggles `QA_CREATE`/`AUTO_REWORK`/`AUTO_DONE` are false and every
    card is pinned to `--agent-id claude`: the orchestrator (Claude sidebar) reviews and lands each card by
    hand. That is the `default` kit with landing `off`, done with the legacy kit's toggles.
- The fork is dogfooded, but its port cards are not landed by the legacy kit.

### 8.2 Principles

- **One owner per responsibility at any time.** Every runtime feature ships **off or in shadow mode** and is
  switched on per workspace. The matching kit service or toggle is switched off in the same step (by the cutover
  card). `kanban doctor` fails if both own the same thing: it reads `run/*.pid` and the kit toggles.
- **Releases batch runtime cards.** Each runtime release (fork.4, fork.5, …) needs a new image and a container
  restart done by the user on the host. Before each one: `kit prepare-restart` (later `kanban restart prepare`),
  plus a backup tarball of `~/.cline/kanban`, `~/.kanban/data` and `~/.kanban/kit.config.json`.
- **The kit keeps running until its last responsibility moves.** No edits under `/root/.kanban` code are needed
  for the transition, except two small kit cards on the kit board: K-1 (new projects default to everything off,
  effective agent, wake target; §11 "Interim") and K-2 (the kit takes each project's on/off from Kanban's config
  after P3-1).

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

1. **Shadow day** (the release that has P4-x and P4-T1…T3).
   - `kanban config import-kit` maps the projects (§3.5): foo gets kit `team` with its overrides, landing `qa`
     and `pipeline.shadow: true`; every other project gets `default` with landing `off`. kit.config.json is then
     kept only as a backup.
   - Check with `kanban kit show --project foo` that the resolved policy is foo's live one: same QA agent per
     dev model, same rework rounds and same escalation.
   - The pipeline logs every decision it would take next to the kit's (`logs/pipeline.log` vs
     `kanban-autoland.log`), including the agent and model `devAssignment` would give each new card. The
     shadow-diff script compares them. Fix the differences, run again.
   - Exit criterion: 24 h with no unexplained difference on a busy board.
2. **Switch foo.**
   - Do this when no card is mid-QA or mid-land, and no runoff is undecided.
   - `touch ~/.kanban/run/{autoland,review-watch,column-sync}.disabled` (column-sync goes earlier, at P2), then
     `kit stop`.
   - `kanban kit apply team --project foo --landing qa` (already applied by the import; this re-checks it) and
     set `workspaces.foo.pipeline.shadow: false`.
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
   - `kanban home migrate --from <old home> --to ~/.kanban` (`--from` is required, `--from-worktrees` names the old
     worktrees root when the old config.json doesn't) copies config/workspaces/hooks/patches, writes
     `backups/home-migrate-<ts>.tgz`, sets `legacyWorktreeRoots`, and writes the home marker. `data/` is copied
     separately; `run/` is not, so restart recovery takes a restart manifest written under the old home if it is at
     most 24 h old (`isManifestForStart`).
   - No pod-spec change: the home is `~/.kanban` of the user running Kanban; `KANBAN_HOME` stays optional.
   - The old home is renamed to `<old home>.migrated-<ts>`, not deleted, and later moved out of `~/.cline`.
   - Done on 2026-10-07 (18:05Z): the old home is `/root/.cline/kanban.migrated-20261007T180526Z`; only card 277f8's
     worktree is left in `/root/.cline/worktrees` (config.json `legacyWorktreeRoots` until it finishes).

### 8.5 Image

- `deploy/Containerfile`:
  - add `deploy/agent-shell/*` → `/usr/local/bin`;
  - add the Playwright Chromium system libs (apt; then `vendor/chromium-libs` goes);
  - keep the cline Bedrock cache patch step.
- The CMD stays (with `--skip-shutdown-cleanup` until §4.5 lands, then harmless).
- `ENV KANBAN_HOME` is **not** baked into the image, and the pod doesn't set it: the home is `~/.kanban` of the user
  running Kanban.
- `.github/workflows/image.yml` needs no structural change. `npm test` picks up the ported tests, so their runtime
  matters: no real agent processes (AGENTS.md: Node 22 CI hang).
- Releases stay on `fork/**` branches. `fork/stack` stays the `:latest` source.

### 8.6 Rollback

| Step | Rollback |
|---|---|
| any runtime feature (P1–P4) | set the workspace setting off, or landing `off` / `pipeline.shadow: true`, `rm ~/.kanban/run/<svc>.disabled`, `kit start` |
| a release | the previous image digest (`podman image inspect … .Digest` is recorded in each release card) |
| P5-2 (foo switch) | `workspaces.foo.pipeline.shadow: true` (or landing `off`), re-enable the kit services. `pipeline-state.json` → `checks-state.json` (same format; the kit ignores `version`) |
| P5-3 (repo retired) | `tar -xzf backups/devteam-kit-final.tgz -C ~/.kanban`, restore the bashrc block from its backup, `kit start` |
| P5-4 (home moved) | stop Kanban and point `KANBAN_HOME` at the renamed old home (`<old home>.migrated-<ts>`, wherever it was moved). Worktrees never moved. Boards changed after the move are in `~/.kanban/workspaces` and can be copied back the same way |

## 9. Tests

The kit has no runner: `test/*.test.cjs` are top-level `assert` scripts, plus two shell dry-run diffs. The fork
uses vitest. Root `vitest.config.ts` runs `test/runtime`, `test/utilities` and `test/integration`; `web-ui` has its
own jsdom config.

Tests are split the same way as the code. **Core tests** run the mechanics against a stub policy (a
`RoutingPolicy` whose answers the test sets), so no core test depends on what `team` says. **Kit tests** run
the resolver and the evaluator on kit JSON, with no pipeline. The team features have their own tests.

**Core tests**

| Kit test | Fork test |
|---|---|
| `cline-hooks.test.cjs` | `test/runtime/terminal/cline-turn-outcome.test.ts` |
| `fork-compat.test.cjs` | session-dir mapping → `test/runtime/terminal/cline-session-files.test.ts`; cardModel parts **D** |
| `cline-agent-id.test.cjs` | **D** (no version sniffing in-process) |
| `agent-trust.test.cjs` (d84bc) | extend `test/runtime/terminal/claude-workspace-trust.test.ts`, `codex-workspace-trust.test.ts` |
| `column-sync-ui-bounce.test.mjs` (bc84c) | `test/runtime/server/session-column-sync.test.ts` |
| `equivalence.sh` (old vs new autoland, dry run on a board copy) | shadow mode + `scripts/pipeline-shadow-diff.ts` during cutover, then **D** |
| `qa-prompt-diff.sh` | core skeleton: fixture tests of `buildQaPrompt` with fixed prompt parts (`test/runtime/pipeline/qa-prompt.test.ts`) |
| (none) | `test/runtime/core/effective-agent.test.ts`: summary agent > card agent > `selectedAgentId`; the same for the model, including a Cline card with no model (providers.json `lastUsedProvider`) |
| (none) | **Incident regression** `test/runtime/pipeline/effective-agent-incident.test.ts` (10/06, §4.0). Board: `selectedAgentId: "claude"`, three cards in Review with work: no `agentId`, `agentId: "claude"`, `agentId: "cline"`. (a) workspace with no kit and landing `off`: no QA card, no land, no rework, no escalation for any of them. (b) the stub policy receives `agentId: "claude"` for the first card, never `cline` and never `undefined`. (c) a second workspace with kit `team` in the same config does not change (a): no inheritance. (d) the global default changes to `cline` while a Claude session is running: the card is still Claude (the summary wins). (e) no core module compares an agent id to a string literal (a grep gate, like the `.cline/kanban` one in §6.1) |
| (none) | `test/runtime/core/dev-assignment.test.ts` (P3-5): `default` → the card is created unchanged; `team` → Cline + the tier-3 model; an explicit agent/model wins; shadow → logged, not applied |
| (none) | `test/runtime/pipeline/landing-modes.test.ts`: `off` arms nothing; `commit`/`pr` as upstream; `qa` + `qaPolicy: none` waits for Approve & land; manual Done on `qa` asks "land or discard?" |
| (none) | `test/runtime/pipeline/rework-limits.test.ts`: a stub `onFail` that always says `rework` is cut off at `maxFailRounds` (+ handback rounds) and escalates; `rework` on an agent that can't resume the same model becomes `escalate`; `requireApproval` parks the card in Backlog `BLOCKED:` |
| (none) | `test/runtime/pipeline/watchdog-wake.test.ts`: the wake target is `createHomeAgentSessionId(ws, selectedAgentId)` for `claude`, `codex` and `cline`; headless falls back to sidebar when the agent has no headless runner |
| (none) | `test/integration/pipeline-land.integration.test.ts`: temp repos for clean / conflict / noop / base-checked-out-with-dirty-tree land. Same for snapshots and the hold (`releaseHold` land / discard + preserve tag) |

**Kit tests** (`test/runtime/kits/`)

| Kit test | Fork test |
|---|---|
| `qa-route.test.cjs` (3c292) | `team-qa-routing.test.ts`: OpenAI-built → Cline + Haiku + `drive`; others → codex; a Cline card with no model uses the effective model; `requireDifferentVendor` rejects a same-vendor route |
| (none) | `kit-schema.test.ts`: `kits/default.json` and `kits/team.json` parse; unknown keys fail; a user kit named `team` is refused |
| (none) | `resolve-kit.test.ts`: override > kit > `default`; arrays replace; a workspace without `kit` resolves to `default`; `kanban kit show` lists each value's source |
| (none) | `default-kit.test.ts`: every question gets the documented "no" (§4.0 table) |
| (none) | `tier-lookup.test.ts`: `dev.model: { tier: "tier3" }` → the tier's `default` entry, else its first; `dropped` models skipped; an empty tier is a schema error at `kanban kit apply` |
| (none) | `team-parity.test.ts`: the `team` kit + foo's overrides give the same answers as foo's live kit.config.json for a fixture set of cards (dev models, rounds, conflict, STALLED). `import-kit.test.ts`: foo → `team` + overrides, kanban-2uge → `default`, never top-level routing onto a project |
| `qa-prompt-diff.sh` (team part) | `team-qa-prompt.test.ts`: foo's QA prompt from `team` + overrides equals the kit's `qa-card.cjs --dry-run` output (fixtures taken before cutover) |

**Team-feature tests** (`test/runtime/kits/team/`)

| Kit test | Fork test |
|---|---|
| `aws-prices.test.cjs` | `bench/aws-prices.test.ts` (same fixtures) |
| (none) | `scoreboard.test.ts` (one line per `verdictRecorded`, nothing when the feature is off), `card-metrics.test.ts` (resumed-session de-dup, the cumulative last message), `runoffs.test.ts` (decide by score, then FAIL rounds, then cost; `benchOnly`; hand-trashed cards, the 10/06 tier2-coupons case) |

Shared helpers to add:

- `test/utilities/kanban-home.ts` `withTemporaryKanbanHome()`. It replaces the per-file `HOME` hacks and is used by
  every pipeline and kit test.
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
`kanban-2uge` (base `fork/stack`). "∥" means it can run in parallel with the others in its phase. Cards marked
**kit card** go on the legacy kit's `kanban` board and change `/root/.kanban`.

**Interim (until the port)**

- Today `kit init` adds a project entry with no toggles of its own. `lib/config.cjs` then gives it the top-level
  `devAgent`/`qaAgent`/`qaRoutes` and the toggles `QA_CREATE`/`AUTO_REWORK`/`AUTO_DONE = true`. That is foo's
  routing, and it is how `kanban-2uge` got QA'd and landed on 10/06 (§4.0).
- The interim fix makes the legacy kit behave like the `default` kit for every project that hasn't opted in.
  It is one small kit card, **K-1**. It does more than give new projects toggles off: it **stops the toggle
  inheritance for every project**, existing ones included. So foo keeps its automation only because K-1 writes
  foo's three toggles explicitly `true` in kit.config.json in the same change. Any other configured project
  that relied on the inherited `true` stops being QA'd, reworked and landed (on this machine that is only
  `kanban-2uge`, which already has them off). Until K-1 lands, keep the current workaround on `kanban-2uge` (toggles off,
  cards pinned to `--agent-id claude`) and use the same workaround for any new project.

| Card | Scope | Depends on |
|---|---|---|
| K-1 ∥ (**kit card**) | (1) `lib/config.cjs`: a project no longer inherits `QA_CREATE`/`AUTO_REWORK`/`AUTO_DONE` from the top level; they default to false unless the project entry sets them. In the same change, foo's entry in kit.config.json gets them explicitly `true` (backup first; foo must not stop at the reload). (2) `kit init` writes the three toggles as `false` and prints how to opt in. (3) autoland uses the effective agent (`card.agentId ?? selectedAgentId`, from `runtime.getConfig`) instead of the literal `"claude"` checks in `isFlowDevCard`/`createQa`/rework. (4) review-watch wakes `__home_agent__:<ws>:<selectedAgentId>`. (5) `kit check` warns about a project that has the toggles on with no explicit entry. Tests: no inheritance; a card with no agentId + default claude is not a dev card. Then `kit start --reload-if-changed`. After it, `kanban-2uge` cards no longer need pinning | – |
| K-2 (**kit card**) | The legacy kit reads `workspaces.<id>.landing.mode` and `.kit` from Kanban's config.json when present (written by P3-1/P3-2). A project's three toggles are on only for landing `qa` with a kit that has `qa.enabled`. So the "which board is automated" switch lives in one place before cutover | P3-1 |

**Phase 0: carry-over (no runtime release)**. Scope unchanged.

| Card | Scope | Depends on | Status / where it fits |
|---|---|---|---|
| P0-1 | ~~Finish d84bc, bc84c, 3c292 on the kit~~: done, kit main `cc6ef30` (§7.3) | – | done |
| P0-2 ∥ | Copilot JSONC fix: cherry-pick `local-forks/fork/cline-only` `1b1f54c8` onto fork/stack, move fork/copilot to `86866b9f`; tests. Ships in fork.4 | – | landed as `74248caa`. Core (agent adapter) |
| P0-2b ∥ | Rescue `forks/kanban-ux`: WIP patch backup, uncommitted diff → `wip/ux-batch-uncommitted`, `ccfa73d` rebased as `fork/ux-batch`; then retire `~/.kanban/forks` per §7.4 (delete the clone, worktrees and sandboxes once every rescued commit is reachable from `/projects/kanban`) | – | card 0a197, waiting for the user's OK to delete. Housekeeping |
| P0-3 ∥ | History archive (cut at kit main ≥ `cc6ef30`): filter-repo, secret scans (user runs the exact-value one), orphan branch `archive/devteam-kit` locally, `scripts/secret-guard.sh`, `docs/team/HISTORY.md` index. No push without the user | – | card d59e1, landed as `d474d7df` (push still needs the user). History for both core and team ports |

**Phase 1: foundations (release fork.4)**. Scope unchanged. All are **core**.

| Card | Scope | Depends on | Status / where it fits |
|---|---|---|---|
| P1-1 ∥ | `src/state/kanban-home.ts` resolver, `--home`/`KANBAN_HOME`/`worktreesRoot`/`legacyWorktreeRoots`; replace the 10 hard-coded sites; UI shows paths from the API; grep-gate test; `withTemporaryKanbanHome`. On the pod it resolved `~/.cline/kanban` until P5-4 removed that step | – | card d18bd, in review. Core; `kits/` lookup for user kits goes through it (P3-1) |
| P1-2 | `kanban home migrate [--dry-run] [--worktrees]` (refuses while the server runs; backup tarball; marker) | P1-1 | card 836b0. Core |
| P1-3 ∥ | Claude/Codex pre-trust by main git root in `claude-workspace-trust.ts`/`codex-workspace-trust.ts` (port of d84bc's agent-trust), before every spawn; diagnose the missed TUI auto-confirm | P0-1 (d84bc landed) | card a85d2, in rework. Core (agent adapters) |
| P1-4 ∥ | `task-trash-workflow.ts`: one server-side Done workflow used by CLI trash, the auto-review reconciler and the browser | – | card c1203, in rework. Core: the only path to Done for land (P4-4), the hold's discard, runoff losers |
| P1-5 ∥ | `deliverTaskInput()` with delivery confirmation; the reconciler uses it; exposed via tRPC (kit's `kanban-runtime.mjs` can switch to it) | – | card ad38e, landed as `6d83dbdf`. Core: rework, nudges, wake all use it |

**Phase 2: session sync + model lists (release fork.5)**. Scope unchanged; all **core**. These cards are not created yet.

| Card | Scope | Depends on |
|---|---|---|
| P2-1 | `session-column-sync.ts` (server moves `in_progress ↔ review`, `updatedAt` guard, no interrupted→trash); the browser stops moving columns; setting `sessionSync` default on for this fork. Cutover: disable kit column-sync | P1-4 |
| P2-2 ∥ | cline-cli turn-end detector in the adapter (idle final reply, STATUS line, QA final line, no-images, quiet-after-bounce; from column-sync + bc84c) | – |
| P2-2b | session sync asks the Cline turn-end check (`requireStatus: false`) before it moves a running Cline CLI card out of Review (an idle open TUI bounced it); honours `agents.cline.turnDetector.mode` | P2-1, P2-2 |
| P2-3 ∥ | `/api/model-lists/lemonade` route + config; Cline `modelsSourceUrl` updated by `kanban setup`; retire the model-lists service | – |

**Phase 3: core settings, kit schema, CLI (release fork.5 or fork.6)**

| Card | Scope | Depends on |
|---|---|---|
| P3-1 | Core settings schema (§3.1, `pipeline-config.ts`); kit schema (§3.2, `kit-schema.ts`); the resolver (§3.4: override > kit > `default`, user kits in `$KANBAN_HOME/kits/`); `kits/default.json` and `kits/team.json` (team's routing filled from foo's live config, so P4-T1 only adds parity tests); `resolveEffectiveAgent`/`resolveEffectiveModel` (`src/core/effective-agent.ts`, pure; nothing calls them yet); the `RoutingPolicy` evaluator (pure), including the tier → model lookup for `dev.model: { tier }` (data only: the tier's `default` entry, else its first, skipping `dropped`); `kanban kit list|show|apply` and `kanban config show`. No behaviour change: only `kanban kit show` calls the evaluator, and the reconciler is untouched (it switches to the resolver in P4-1). Tests: `kit-schema`, `resolve-kit`, `default-kit`, `effective-agent`, `tier-lookup` | P1-1 |
| P3-2 | `kanban doctor [--fix] [--deep]` (kit check + switch-check + "one owner" check + trust + each project's kit/landing), `kanban project add --kit --landing`, `project sync`, `kanban setup` (npmrc, rules, providers, CLAUDE.md section, trust; no bashrc), `kanban config import-kit` (§3.5; `--dry-run` prints the mapping) | P3-1, P1-3 |
| P3-3 ∥ | `kanban models probe|providers` (bedrock probe, providers; core, outage recovery needs them). Prices moved to P4-T2 | P3-1 |
| ~~P3-4~~ | moved to the team kit as P4-T2 (bench, scoreboard and prices score routing decisions) | – |
| P3-5 ∥ | `devAssignment` at card creation (server side, so CLI `task create`, tRPC and the UI share it): when the creator set no agent/model, ask the workspace's resolved kit and store the answer on the card (`agentId`, model settings, provider via `kanban models providers`); the UI create dialog preselects the proposed agent/model and shows "from kit `team`". An explicit agent/model always wins. Behind the kit: `default` answers `null`, so nothing changes on a board without a kit. With `pipeline.shadow` on, the proposal is only logged (the card is created as today). Tests: `default` → card unchanged; `team` → Cline + the tier-3 model; explicit `--agent-id claude` wins; shadow → logged, not applied | P3-1 |

P3-2, P3-3 and P3-5 can run in parallel after P3-1. K-2 can start right after P3-1.

**Phase 4: core pipeline (shadow first; release fork.6)**. Every card here is **core**, tested against a stub
policy. None of them reads `kits/team.json`.

| Card | Scope | Depends on |
|---|---|---|
| P4-1 | Pipeline skeleton: worker process (decision 1), state store `pipeline-state.json` (reads checks-state.json), events from the state hub, landing mode per workspace + `pipeline.shadow`, decision log; `autoReviewMode: "qa"` + card `role` in the API contract and UI; every decision asks the `RoutingPolicy` of the workspace's resolved kit; the reconciler and session sync switch to `resolveEffectiveAgent` (a **behaviour change**: the agent the session ran on now wins over `card.agentId`); the feature registry and event bus (`verdictRecorded`, `landed`, `reworkSent`, `escalated`); the **effective-agent incident regression test** | P2-1, P3-1 |
| P4-2 ∥ | Snapshots + scripted checks + board backups | P4-1 |
| P4-3 ∥ | QA gate: `qaPolicy` call, prompt skeleton + kit prompt parts, QA cards (`role: "qa"`, `reviewsTaskId`), slots/queue, outbox ingest, qa-log, artifacts, preview start/stop, `kanban qa shot` | P4-1 |
| P4-4 ∥ | Land: `land.ts` (merge-tree, squash, postLand) → Done workflow; landing modes `off`/`commit`/`pr`/`qa`; Approve & land button; "land or discard?"; `kanban task approve`; the hold (`onPass`, `releaseHold`, preserve tags) | P4-1, P1-4 |
| P4-5 | Rework loop: `onFail` answers → rework (REWORK section, `/clear` thresholds, delivery, started-check), the `maxFailRounds` cap, escalation mechanics (to the orchestrator; to a model = sibling card; `requireApproval`), runoff spawn (sibling cards in a group), `kanban task handback` | P4-3, P4-4 |
| P4-6 ∥ | Recovery: nudges, premature stop, poisoned history, hung-request cancel, transient/outage + probes, provider capacity (`maxLoadedModels`), restart recovery, `kanban restart prepare|recover`, `kanban task resume|send|restart-fresh` | P4-1, P1-5, P3-3 |
| P4-7 ∥ | Watchdog: stalls, ATTENTION.md, orchestrator wake on the **selected agent** (headless/sidebar, lock, live-session check, `--when-*`), pid pressure, prune-done, the feature-job runner (daily jobs), stuck-on-prompt detection (d84bc part 2), `kanban board prune-done|restore` | P4-1 |
| P4-8 | `scripts/pipeline-shadow-diff.ts` + docs rewritten: `docs/team/{WORKFLOW,RUNBOOK,CONFIG}.md` (core) and `docs/team/KITS.md` (schema, `default`, `team`, writing a user kit) | P4-2…P4-7, P4-T1…P4-T3 |

P4-2, P4-3, P4-4, P4-6 and P4-7 can run in parallel right after P4-1.

**Phase 4T: the `team` kit (release fork.6)**. These cards port foo's routing and the scoring features. They
touch only `kits/team.json`, `src/kits/team/` and their tests. They can run beside Phase 4 once their
dependencies are in.

| Card | Scope | Depends on |
|---|---|---|
| P4-T1 | Routing parity: finish `kits/team.json` (the `drive` rule text from `PROMPT_RULES`, QA prompt notes, tiers/dropped) and foo's overrides from the import mapping. Tests `team-qa-routing`, `team-parity` (against fixtures from the live kit.config.json), `team-qa-prompt` (against `qa-card.cjs --dry-run` fixtures) | P3-1, P3-2 (the import mapping and `import-kit.test.ts`); the prompt test needs P4-3 |
| P4-T2 ∥ | Scoreboard + bench + prices (was P3-4 + prices): `scoreboard` feature on `verdictRecorded`, card-metrics, `kanban bench metrics|record-verdict|scoreboard|reset`, `kanban models prices sync [--apply|--check]` + the daily check as a feature job, data in `data/prices` | P3-1 for the CLI; P4-1 for the events; P4-7 for the job |
| P4-T3 | Runoffs + tiers: the `runoffs` feature on the core hold (decide, preserve tags, delete losers through the Done workflow, `benchOnly`, hand-trashed cards); `kanban bench runoff create|status`; the `tiers` feature: `escalate.to: { tier }` (tier-2 escalation, a sibling card on that tier's model) and `kanban bench tiers`. The tier → model lookup itself is already in the P3-1 evaluator | P4-4, P4-5, P4-T2 |
| P4-T4 | Calibration: `kanban bench calibrate <spec>` (detached, resumable, `role: "calibration"` cards). Needed before P5-3 (the legacy kit's calibrate.mjs goes then), not before P5-1 | P4-3, P4-T2 |

P4-T2 can start as soon as P3-1 lands, and P4-T1 once P3-2 is in, both in parallel with P4-1.

**Phase 5: cutover (orchestrator + user, one card each)**. foo cutover = apply `team` + landing mode `qa`.

| Card | Scope | Depends on |
|---|---|---|
| P5-1 | Shadow day on foo: `kanban config import-kit` (foo → `team` + overrides, landing `qa`, shadow; everything else `default`/`off`), `kanban kit show --project foo` checked against the live kit, `devAssignment` proposals logged next to the orchestrator's choices; fix the differences (new cards as needed) | P4-8, P3-2, P3-5 |
| P5-2 | Switch foo: shadow off (`kanban kit apply team --project foo --landing qa`; from here new foo cards without an agent get Cline on tier 3 from `devAssignment`), legacy kit services disabled, state copied; one full card cycle watched. `kanban-2uge` confirmed on `default` / landing `off` | P5-1 |
| P5-3 | Retire the kit repo: `kanban` board emptied and unregistered, final tarball, code removed, data moved, bashrc/CLAUDE.md, the user's settings.json step; `forks/` gone (P0-2b) and the `local-forks/*` refs deleted | P5-2, P0-2b, P0-3, P4-T4 |
| P5-4 | Home move in a restart window (`kanban home migrate`, pod `KANBAN_HOME`); `kanban doctor` clean | P5-3, P1-2 |

## 12. Decisions for the user

Decided (2026-10-06), recorded here so later cards don't reopen them:

1. **Pipeline process model** (§5): the pipeline and watchdog (and now the kit resolver and team features) run as
   a supervised worker child of the server.
2. **Landing model** (§4.2): landing mode `qa`, where Kanban itself squash-lands onto the base (stash +
   `merge --squash` in a checked-out base) **before** the card goes to Done, and a manual Done asks "land or
   discard?". `commit`/`pr` stay.
3. **Home default and history** (§6.1, §10): `~/.kanban` (the legacy `~/.cline/kanban` detection was removed at P5-4); running
   worktrees never moved; kit history as the orphan `archive/devteam-kit`, pushed only after the exact-value
   secret scan the user runs.
4. **Core vs routing kits** (§4.0): the core does the mechanics and resolves the effective agent. A per-project
   kit answers the routing questions. Every project defaults to `default` (selected agent, landing `off`, no QA,
   no rework automation) and nothing is inherited. `team` is foo's preset, applied in one step. The orchestrator
   is always the selected agent. Kits are declarative (zod-typed JSON); built-in kits are in `kits/`, user kits in
   `$KANBAN_HOME/kits/`; no code hooks for user kits. The runoffs, scoreboard and calibration code is built-in
   `team` features.

Smaller choices, with defaults already taken in this doc (say if one is wrong):

- **K-1 stops toggle inheritance for every project now**, not only for new ones (§11 "Interim"). foo keeps
  QA, rework and landing because K-1 sets its three toggles explicitly `true` in kit.config.json. Any other
  project would lose them; today that is only `kanban-2uge`, which already has them off. The alternative is to
  keep inheritance for existing entries and default only `kit init`'s new entries to off.

- **Recovery on `default` projects**: on. Crash nudges, outage holds and restart recovery continue a crashed
  card on any board; they never QA, land or rework. Off would mean a crashed card on `kanban-2uge` waits for the
  orchestrator.
- **Claude-built dev cards on a `team` board get QA** (by Codex, a different vendor). Today foo skips them only
  because of the literal `agentId === "claude"` check. The other option is `qa.skip.effectiveAgents: ["claude"]`
  in foo's overrides. The P5-1 shadow diff will show this difference.
- **No automatic senior-tier escalation** in `team`: after 3 FAILs the card goes to the orchestrator with
  `requireApproval`, as today (tier-2 runs cost more than about $20 and need the user). `escalate.to: { tier:
  "tier2" }` is a one-key opt-in.
- **"kit" now means a routing kit** (`kanban kit …`); the old repo is the "legacy kit". The alternative is to
  call them "routing profiles" (`kanban routing …`).
- interrupted cards are never auto-trashed;
- the browser stops moving columns;
- `qa-servers.sh` and the `dev-servers.md` rule move to the foo project;
- the image ships the Chromium libs;
- the port cards on `kanban-2uge` are landed by the orchestrator, not by the legacy kit (since the 10/06
  incident; it was "QA-gated by the current kit" at 20:5xZ).
