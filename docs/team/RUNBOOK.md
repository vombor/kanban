# Runbook

How to operate the team workflow day to day. The reasons behind the rules are in [WORKFLOW.md](WORKFLOW.md), the
settings in [CONFIG.md](CONFIG.md), routing kits in [KITS.md](KITS.md). `<home>` is the Kanban home (`kanban
doctor` prints it): `KANBAN_HOME` if set, else `~/.kanban` of the user running Kanban (on the pod
`/root/.kanban`; the pod spec sets no `KANBAN_HOME`). Kanban keeps nothing in `~/.cline`, which is the Cline CLI's.

## Where things live

| What | Where |
|---|---|
| Settings (core + which kit each project uses) | `<home>/config.json` |
| User routing kits | `<home>/kits/<name>.json` (built-in `default` and `team` ship in the package) |
| Board state | `<home>/workspaces/<id>/{board,sessions,meta}.json` |
| Per-project pipeline data | `<home>/data/<ws>/`: `pipeline-state.json` (per-card history; `qaflow` keeps the legacy key names), `pipeline-decisions.jsonl` (every decision, rotated to `.1` at 5 MB), `qa-log.md`, `qa-artifacts/<dev>/r<n>/`, `ATTENTION.md`, `watchdog-state.json`, `watchdog-decisions.jsonl`, `dev-assignment.jsonl`, `restart-manifest.json`, `runoffs.json`, `scoreboard.jsonl/.md`, `calibration/<name>/` |
| Prices | `<home>/data/prices/` (the package seed is `assets/prices.default.json`) |
| Board backups | `<home>/backups/boards/<ws>/board-latest.json` (every write) + `board-<time>.json` (every 10 min, 200 kept); prune-done backups in `prune-done-<time>/` |
| Logs | the server's own output (the pipeline worker logs there too); `<home>/logs/` for orchestrator runs, `calibrate.log`, `price-sync.log` |
| Locks, markers | `<home>/run/`: `server-start.json`, `orchestrator-<ws>.lock`, `pid-pressure`, `pid-brownout`, `restart-recover.now`, `qa-preview-<ws>.pid` |
| Task worktrees | `<home>/worktrees/<id>/<repo>`; after a home move also the roots config.json lists in `legacyWorktreeRoots` (read-only, until their cards finish; doctor warns while an entry exists) |
| Scratch (throwaway) | `/tmp/kanban-qa/<dev>` (QA copies), `/tmp/kanban-qa-out/<qa>` (QA outboxes), `/tmp/kanban-checks/<dev>` (scripted checks) |

## At a glance

```sh
kanban doctor [path] [--fix] [--deep]   # home, every project's kit + landing, trust, managed sections, guardrails,
                                        # setup drift, and the one-owner check vs the legacy kit. Read-only without --fix
kanban pipeline status [--workspace W]  # landing mode, shadow, kit, whether the pipeline runs, latest decisions
kanban config show [--workspace W]      # resolved core settings
kanban kit show --project W             # resolved kit, each value with its source
kanban bench runoff status [--all]      # open runoffs (team kit)
```

Run `kanban doctor` at the start of an orchestrator session and after any setting change. A failing one-owner row
means two things own the same job (for example the pipeline landing a project the legacy autoland still watches).
Fix it before anything else.

## Projects

- **Add an existing repo:** `kanban project add <path> [--kit <name>] [--landing off|commit|pr|qa] [--base B]
  [--name N] [--blurb "Project: …"] [--agents-md]`. It registers the repo with Kanban, pre-trusts it for Claude Code
  and Codex, and creates `data/<ws>/`. Without `--kit` the project is on `default` with landing `off`: plain
  Kanban, landed by hand. The browser's "Open folder" does the same registration.
- **Brand-new project:** `kanban project create <path> [--name N] [--branch main] [--no-initial-commit]`, or "New
  project" in the browser's Add Project dialog. It makes the directory (new or empty, not inside another git repo),
  runs `git init -b <branch>`, commits a `README.md` (`# <name>`) unless told not to, and then adds it like
  `project add`. Without a git identity the commit is made as "Kanban (no git identity configured)" for that commit
  only (git config is never changed) and the result says so.
- **Where projects live:** new, cloned and opened projects must be strictly inside a projects root
  (`projects.roots`, see CONFIG.md; `/projects` in the container, the projects volume). Projects registered
  before keep working; `kanban doctor` warns about each one outside the root.
- **Opt a project into the team workflow:** first set `workspaces.<ws>.pipeline.shadow: true` in config.json
  (shadow is a core key, not a kit key), then `kanban kit apply team --project <ws> --landing qa --dry-run`, then
  without `--dry-run`. Watch the decision log for a while before turning shadow off (see "Shadow day").
- **Project-specific QA text and postLand:** overrides, e.g. `kanban kit apply team --project foo --set
  qa.blurb="Project: Pawsome…"`. `--unset <key>` removes one.
- **Managed sections** (the `agents-qa` section in a project's AGENTS.md): `kanban project sync <path> [--dry-run]`
  rewrites only the text between the managed markers. The edit is an uncommitted change in the project; land it
  through a card.
- **Machine setup** (npm settings, Cline rules, the Bedrock provider entry, the CLAUDE.md section, trust):
  `kanban setup [--dry-run]`. While the legacy kit's `kit.config.json` exists, it leaves the CLAUDE.md section alone
  unless `--claude-md`.

## Switching a runtime feature on (one owner at a time)

Each feature ships off, in shadow or report-only. Switch it on only in the same step that switches the legacy owner
off, then run `kanban doctor`.

| Feature | Default | Legacy owner (2026-10-07) | On |
|---|---|---|---|
| Session sync (In Progress ↔ Review) | on | column-sync: retired | `sessionSync.enabled` (restart) |
| Model-lists route | on | model-lists service: retired | `kanban setup` points Cline's Lemonade provider at it |
| Cline turn detector / idle-TUI check | `report` | column-sync: retired | `agents.cline.turnDetector.mode: "on"` |
| Pipeline: snapshot, checks, QA gate, land, rework | landing `off` | autoland (running) | `workspaces.<ws>.landing.mode: "qa"`, `pipeline.shadow: false` (foo: P5-2) |
| Recovery (nudges, outage holds, restart resumes) | `report` | autoland (running) | `pipeline.recovery.mode: "on"` |
| Watchdog (stalls, ATTENTION.md, wakes, prune-done, price check) | `off` | review-watch (running) | `watchdog.mode: "on"` |

The server re-reads config.json every 30 s. A landing-mode, recovery or watchdog change starts or stops the
pipeline worker without a Kanban restart. `sessionSync.*` is read only at server start.

**Pause the pipeline:** set `pipeline.paused: true` (landing and recovery stop; the watchdog keeps running if it is
on). There is no `pause` command.

**Worker on a newer build** (the dev pod's live-fix loop): set `pipeline.workerEntry` to that build's
`dist/cli.js`. The host restarts a worker that exits, after a growing delay.

## Day to day

| Task | Command |
|---|---|
| Approve & land without QA (landing `qa`) | the card's Approve & land button, or `kanban task approve --task-id <id>` |
| Done on a card with unlanded work | `kanban task done --task-id <id> --land` or `--discard` (the browser asks "land or discard?"; a Done with no choice is refused) |
| Hand an escalated card back | `kanban task handback --task-id <id> --note "<why>" [--extra-rounds N] [--by NAME]` |
| Release a held PASS (runoff) | `kanban task release-hold --task-id <id> --land` or `--discard [--tag preserve/<id>-<model>] [--note …]` |
| Type into a card | `kanban task send <id> "<text>"` or `@file` (`--no-enter` to only type) |
| Restart a dead card | `kanban task resume <id…> [--dry-run]`: WIP tag, a new session with the card prompt (+ a WIP note when the worktree has changes), same agent and model; a Claude card continues its conversation (`--continue`) with a resume note instead |
| Start over, maybe on another model | `kanban task restart-fresh <id> --model <m> --label <suffix> [--provider P] [--hold] [--after <id>] [--note …]` |
| Queue an orchestrator wake | `kanban orchestrator wake "<issue>" [--when-card-done <id> \| --when-model-up <m>]` |
| Prune Done | `kanban board prune-done [--workspace W] [--days N] [--dry-run]` (the watchdog does it hourly when on) |
| Start a runoff | `kanban bench runoff create <name> (--model … \| --tier …) (--prompt … \| --from <id>) [--bench-only] [--start]` |
| Calibrate QA models | `kanban bench calibrate <spec> [--project W] [--foreground] [--print] [--force]` |
| Score, metrics, prices | `kanban bench scoreboard`, `kanban bench metrics <id>`, `kanban models prices sync [--apply\|--check]` |

- **Never `stopTaskSession` to switch models**: the session ends "interrupted" and the card moves. Use
  `restart-fresh`.
- **Never `kanban task start` a Review card** to revive it: start refuses Review cards and returns a live session
  unchanged. Use `resume`.
- **Calibration cards belong to their runner** (`role: "calibration"`, title `QA-CAL …`). The pipeline, auto-review
  and the watchdog's stall checks leave them alone, and session sync still moves them because the runner waits for
  Review. Only one runner works on a calibration (`runner.pid`, taken over from a dead holder). A rerun retries runs
  that were skipped because their agent was signed out. While the board can't be read (server restarting), started
  runs still end at their timeout. A finished calibration has `finishedAt` in its `state.json`.
- **Runoff and bench cards are real dev cards**: QA, rework and escalation as usual. A card inside an open runoff
  never escalates to a model, because its sibling would race outside the group. `benchOnly` runoffs land nothing.

## Incidents

**Planned restart (Kanban or container).** On every container stop the image entrypoint runs, while Kanban is still
up and before passing the signal on, the legacy kit's `kit prepare-restart` (`$KANBAN_PRESTOP_HOOK`, at most 45 s)
and then `kanban restart prepare` for every workspace (`$KANBAN_RESTART_PREPARE_HOOK`, at most 20 s; the runtime's
equivalent: it tags the WIP of mid-turn cards and writes `restart-manifest.json` with the server's start time).
Each step logs one result line to `<kit home>/logs/kanban-entrypoint.log` (`restart prepare done` / `failed` /
`timed out`); a failed or hung step never holds up the stop (`deploy/kanban-entrypoint.sh`,
`docs/fork/container-lifecycle.md`). Only a Kanban-only restart (no container stop) needs both run by hand first.
`kanban restart recover --dry-run` shows what restart recovery would do on the live board. Without `--dry-run` it
asks the worker to check now. Never restart the pod yourself: that is the user's step on the host.

- Until the cutover, restart resumes come from the legacy autoland. `pipeline.recovery.mode` stays `report`, so
  never both: a double resume starts two sessions. Both resume a Claude card the same way: `claude --continue` with
  a resume note as its next turn (the legacy kit since `a2b4695`; the runtime's `kanban task resume`, and recovery
  in mode `on`). Every other agent, Cline included, gets a new session with the card prompt (+ a WIP note).
- A card that still shows "running" after a restart has no process. `kanban task resume <id>` brings it back.
- Restart recovery finds every In Progress card without a process, with or without a manifest entry or a session
  summary (`sessions.json` only gets summaries with a browser save, 277f8 on 10/07). The manifest adds the WIP tags
  and the Review cards whose turn was still running.
- **Home move** (Kanban stopped, a one-off): `kanban home migrate --from <old home> --to ~/.kanban` (`--from` is
  required; `--from-worktrees <dir>` when the old home's config.json doesn't name its worktrees root). It copies
  config/workspaces/hooks/patches; copy `data/` yourself, which carries `restart-manifest.json`. `run/` stays behind,
  so the new home has no start record of the server that wrote the manifest: recovery takes such a manifest when it
  is at most 24 h old. Rename the old home (`<old home>.migrated-<ts>`) and move it out of `~/.cline` once no rollback
  needs it. Rollback: stop Kanban and point `KANBAN_HOME` at the renamed old home.

**Stuck card.**

- *Review, no QA, no verdict:* `kanban pipeline status --workspace W` shows the newest decisions for it. Common
  reasons: the Review hasn't settled (a resumed turn), the kit answered `none`, recovery holds it (outage, retry,
  orphan), it is escalated, or the snapshot has no changes against its base.
- *Claude/Codex card on a trust or permission dialog:* flagged in `ATTENTION.md` as `**<id>** (prompt)` after 3 min.
  Nothing types into it, because the trust dialog's default is "No, exit". Open the card's terminal and pick "Yes,
  I trust this folder", or restart the card. Prevention: `kanban doctor --fix` pre-trusts each repo's main root.
- *In Progress, dead session:* the watchdog sends one continue after 5 min, then wakes the orchestrator. By hand:
  `kanban task resume <id>`.
- *Escalated:* read `## ESCALATE` in `data/<ws>/qa-log.md` and `ATTENTION.md`, then `kanban task handback`, or
  `restart-fresh` on another model. More FAIL rounds than the cap is a budget call: only on the user's say-so.
- *A runoff that won't decide:* `kanban bench runoff status <name>`. A card trashed by hand closes the runoff. A
  winner whose land conflicts goes down the rework conflict path. `release-hold` ends any hold.

**A guardrail refused a command.** The card's agent tried something on the deny list (a push, a shared-branch
rewrite, a restart). Cline: the hook cancels the tool and ends the turn, so the card goes to Review. The other agents get
their CLI's own refusal. The orchestrator does the landing. A workspace can only add rules
(`workspaces.<ws>.guardrails.extraDenyCommands`).

**False "no changes" snapshot.** The decision log says `no changes against <base>; not submitted` when the card
reached Review without work, or the agent committed onto the base itself. Check the worktree (`git -C <worktree>
status`, `log -3`) and `git log <base> -15`. If the work is real, move the card through In Progress → Review to
re-snapshot it.

**Board wiped** (Kanban removes a workspace's state when a `git rev-parse` fails, e.g. at the pids limit):
`kanban board restore <ws> [backup]` (default: the newest `board-latest.json`; it refuses unless the state dir is
empty or missing), then reload Kanban in the browser.

**Kanban sidebar freeze** (the orchestrator stops responding): kill the sidebar agent process (the agent child of
the Kanban server whose command line has "Kanban Sidebar"), then resume it in the sidebar. The 10/05 cause: a
throttled viewer (a background browser tab) paused the PTY. Don't leave Kanban open in hidden tabs.

**PID pressure.** At 75% of `pids.max` the watchdog raises `<home>/run/pid-pressure` and runs the orphan-process
sweep (Done cards' leftovers go first). While the flag is up (or the legacy kit's own `pid-pressure` flag), the QA gate
creates and starts no QA cards, restart recovery resumes no cards and calibration starts no new wave; each hold is
logged once in the decision log and ends by itself when the flag goes. At 90% it raises `pid-brownout` and sends one
Esc to each running agent. Only a container restart with an init as PID 1 clears zombies.

## Shadow day (cutover step P5-1)

Before a project is switched from the legacy autoland to the pipeline, both decide side by side for a day:

1. `kanban config import-kit --dry-run`, then without `--dry-run`. foo gets kit `team` with its overrides, landing
   `qa` and `pipeline.shadow: true`. Every other project gets `default` with landing `off`.
2. `kanban kit show --project foo`: the resolved policy must be foo's live one (same QA agent per dev model, same
   rework rounds, same escalation).
3. Let it run. In shadow the pipeline snapshots (without moving refs), asks the kit, logs every decision with
   outcome `shadow` and acts on nothing. Recovery logs in mode `report`, and new cards' dev assignment is only
   logged.
4. Compare, from a checkout of this repo (read-only, it changes nothing):

   ```sh
   npx tsx scripts/pipeline-shadow-diff.ts --workspace foo --since 24h        # or: npm run shadow-diff -- …
   #   [--until <iso>] [--window-min 10] [--legacy-log <path>] [--home <dir>] [--json] [--verbose]
   ```

   It reads the legacy autoland log (`<kit home>/logs/kanban-autoland.log`), `pipeline-decisions.jsonl` (and `.1`),
   `dev-assignment.jsonl`, the board (for each legacy QA card's agent and model) and the legacy
   `checks-state.json` (for restart-fresh resets). Without `--workspace` it takes every workspace in shadow on
   landing `qa`. Exit code: 0 = no unexplained difference, 1 = some, 2 = bad arguments or unreadable inputs.

5. Fix each difference (a kit override, a code fix on a new card) and run it again. Exit criterion: 24 h on a busy
   board with no unexplained difference.

What it compares, per category:

| Category | Legacy side | Pipeline side |
|---|---|---|
| QA routing | `qa <id>: created QA card <qa>` (+ that card's agent and model on the board), `not a dev card` | the `qa_gate` answer for the card in the same window |
| After a FAIL | the rework or escalation that followed a FAIL, STALLED or conflict | the kit's `onFail`, asked offline with the legacy FAIL history (in shadow the pipeline has no verdicts of its own), or the pipeline's `rework` record when there is one |
| Recovery | crash / poisoned / premature / retry nudges, retry and outage holds | `recovery` decisions (nudge with its cause, hold, cancel, escalate) |
| Restart recovery | the orphans found for each Kanban start (times within 10 s are one start) | the `restart` records for the same start; a start without orphans isn't logged, so a legacy start with none counts as SAME when the worker logged `watching` (recovery not off) soon after it |
| Dev assignment | what each new card was created with | what the kit proposed (`dev-assignment.jsonl`) |

`dev-assignment.jsonl` gets one line per new dev card, from both creators: `kanban task create` writes its own
(`source: "cli"`), and the server logs a card made in the browser's create dialog when the board save that adds it
arrives (`source: "browser"`). The browser line has the same shape: a fresh kit proposal, and as "created" the card's
agent (else the agent selected at that moment) and model. `applied` means the card kept the dialog's preselection,
`explicit` that the user picked something else, `shadow` that nothing was preselected. Each task id is logged once,
so re-saves don't add lines, and cards the pipeline, QA gate, calibration or runoffs create aren't logged at all.
Only workspaces whose kit has a `devAssignment` (`team`) log anything. Lines written before this change have no
`source` and all came from the CLI.

How to read the report:

- `SAME` items are only counted (`--verbose` lists them).
- `KNOWN` items are differences the plan expects: Claude-built dev cards get QA on `team` (plan §12), the
  legacy kit reworks only Cline cards, and phantom restarts. Autoland takes the newest `node …/kanban … --port`
  process in /proc as the server, so a short-lived one (a second `kanban --port …` launch that finds the port taken
  and exits) reads as a new start, and about 15 s later autoland logs the real start again with the phantom as
  "last saw" (2026-10-07 09:08:25Z). The server's own `run/server-start.json` is written only after it has bound
  its port, so the pipeline never sees those. A phantom with orphans stays `LEGACY ONLY`, since autoland may have
  resumed cards that were never orphaned.
- `UNVERIFIED` items mean both sides acted, but one side's details are gone (the card was pruned from the board).
- `DIFF`, `LEGACY ONLY` and `PIPELINE ONLY` items are the ones to explain.
- A whole column of `LEGACY ONLY` means the pipeline decided nothing: the workspace isn't on landing `qa`, the
  worker wasn't running, or the window predates the shadow switch. The report's warnings say which.
- Snapshots, checks and landing have nothing to compare in shadow. Their counts are printed at the end.
- FAIL counting follows the legacy kit: a handback's extra rounds count, and a restart-fresh resets the count (its
  `resetAt`, or a REWORK on a new model). `checks-state.json` keeps only the newest `resetAt`, so a same-model
  restart-fresh before it can show as a DIFF. Check `kanban task handback`/`restart-fresh` history for that card.

Then P5-2 switches foo, in this order:

1. Back up both data dirs. `kanban pipeline import-legacy --project foo --dry-run --force` shows what will be copied
   while autoland still runs.
2. Touch the legacy kit's `run/{autoland,review-watch}.disabled`, `kit stop`. Check that no `run/pid-pressure` or
   `pid-brownout` is left in the legacy run dir (review-watch never removes them; Kanban ignores them once
   review-watch is off).
3. `kanban pipeline import-legacy --project foo` (still in shadow). It copies the open cards' checks-state.json
   entries into pipeline-state.json, runoffs.json, the scoreboard (deduplicated) and qa-log.md, and refuses while
   autoland owns foo or foo is not on landing `qa` in shadow. Running it again changes nothing.
4. Set `pipeline.shadow: false`, and `pipeline.recovery.mode` / `watchdog.mode` to `on` with their doctor rows
   clean. The server and worker read all three from config.json on the next sweep (within 30 s), no restart.
5. Watch one full card cycle.

Rollback: `pipeline.shadow: true` (or landing `off`), then re-enable the legacy services. The legacy files were
only read, so the legacy kit carries on from where it stopped.

## Add a model

1. **Probe:** `kanban models probe <modelId>` (Bedrock Converse with a tool call, through the `us.*` profile when one
   exists; `--provider lemonade` for Lemonade's `/health`). It must answer with a tool call. xAI models are never
   probed.
2. **Provider:** `kanban models providers --for <modelId>` prints the provider a Cline card on it should use.
3. **Smoke card:** a tiny card on that model ("read package.json and report the name"). Watch for tool-call/JSON
   errors.
4. **Prices:** `kanban models prices sync` (dry run), then `--apply`. Models in the AWS Price List get an entry.
   Others need a manual one in `data/prices/prices.json`. Without a price, the cost shows `n/a`.
5. **Tier:** add it to the project's kit (`tiers`, as an override or in a user kit). Tier 2 (more than about $20 per
   run) needs the user's go-ahead.
