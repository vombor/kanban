# Fork modifications

This is a modified version of [Kanban](https://github.com/cline/kanban) by Cline Bot Inc., licensed under the
Apache License 2.0 (see `LICENSE`). The fork lives at https://github.com/vombor/kanban.
As required by Section 4(b) of the license, the files listed below were modified by the fork. The git history
of this repository is the complete record of changes.

- `package.json`: `homepage`, `bugs` and `repository` point at the fork; `CHANGES-FORK.md` is shipped in the package.
- `packages/desktop/`: removed. The fork runs headless and is used through a browser (or the web UI's PWA), so the
  Electron desktop app is not built or shipped. `package.json` (`install:all`), `.github/workflows/test.yml`,
  `.gitignore` and `vitest.config.ts` no longer reference it; `.plan/desktop-5-way-split-handoff.md` is removed.
- `web-ui/src/components/project-navigation-panel.tsx`: removed the Cline logo from the sidebar header; the
  "report an issue" link points at the fork.
- `web-ui/src/components/ui/cline-icon.tsx`: removed (only used by the sidebar header logo).
- `web-ui/src/components/top-bar.tsx`, `web-ui/src/App.tsx`: removed the "Open" button that opened the
  workspace in a local editor or app. It assumes Kanban runs on the user's desktop machine, which the fork does not.
- `web-ui/src/components/open-workspace-button.tsx`, `web-ui/src/hooks/use-open-workspace.ts`,
  `web-ui/src/utils/open-targets.ts`, `web-ui/src/assets/open-targets/*`: removed along with the "Open" button.
- `web-ui/src/storage/local-storage-store.ts`: removed the "Open" button's preferred-target storage key.
- `src/trpc/app-router.ts`, `src/trpc/runtime-api.ts`, `src/server/runtime-server.ts`, `src/cli.ts`: removed the
  `runtime.runCommand` route, which ran an arbitrary shell command in a workspace. Its only caller was the
  removed "Open" button; project shortcuts run in the task terminal instead.
- `src/core/api-contract.ts`, `src/core/api-validation.ts`: removed the `runCommand` request/response schemas and
  validator.
- `src/server/process-termination.ts`, `test/runtime/process-termination.test.ts`: removed (only used by
  `runCommand`).
- `test/runtime/trpc/runtime-api.test.ts`: dropped the `runCommand` dependency stubs.
- `web-ui/src/telemetry/posthog-config.ts`, `posthog-provider.tsx`, `events.ts`, `events.test.ts`: removed. The fork sends
  no PostHog analytics (upstream defaulted to `https://data.cline.bot`).
- `web-ui/src/main.tsx`, `web-ui/src/hooks/use-task-editor.ts`, `use-task-sessions.ts`,
  `use-linked-backlog-task-actions.ts` (and their tests): removed the PostHog provider and event tracking calls.
- `web-ui/package.json`, `web-ui/package-lock.json`: removed the `posthog-js` and `@posthog/react` dependencies.
- `web-ui/vite.config.ts`, `web-ui/src/vite-env.d.ts`, `web-ui/.env.example`: dropped the `POSTHOG_` env plumbing;
  documented the optional `VITE_SENTRY_DSN`.
- `web-ui/src/telemetry/sentry.ts`, `src/telemetry/sentry-node.ts`: removed the hardcoded upstream (Cline-owned) Sentry
  DSNs. Error reporting is off unless a build supplies `VITE_SENTRY_DSN` / `KANBAN_SENTRY_DSN`.
- `scripts/build.mjs`: bakes the optional `KANBAN_SENTRY_DSN`; removed the unused OTEL env defines.
- `scripts/upload-sentry-sourcemaps.mjs`: no hardcoded upstream Sentry org/projects; skipped unless `SENTRY_AUTH_TOKEN`,
  `SENTRY_ORG`, `SENTRY_WEB_PROJECT` and `SENTRY_NODE_PROJECT` are set.
- `.github/workflows/publish.yml`: no PostHog/OTEL secrets; passes the optional fork Sentry secrets instead.
- `DEVELOPMENT.md`: replaced the PostHog section with the fork's telemetry/error-reporting notes.
- `web-ui/src/components/project-navigation-panel.tsx`: sidebar header reads "Kanban v…" instead of "Cline v…".
- `web-ui/index.html`, `web-ui/public/manifest.json`, `web-ui/public/assets/icon.svg`, `icon-192.png`, `icon-512.png`,
  `icon-notification.png`: replaced the Cline logo favicon, PWA and notification icons with a neutral Kanban icon;
  the PWA is named "Kanban".
- `web-ui/public/sw.js`: offline fallback page says "Kanban" and tells you to run `kanban`.
- `web-ui/src/components/app-error-boundary.tsx`, `web-ui/src/hooks/runtime-disconnected-fallback.tsx`,
  `web-ui/src/components/task-start-agent-onboarding-carousel.tsx`: "Kanban" instead of "Cline" / "Cline Kanban"
  as the product name (the Cline agent keeps its name).
- `web-ui/src/components/runtime-settings-dialog.tsx`: "Read the docs" links to the fork's README.
- `src/cli.ts`, `src/workspace/initialize-repo.ts` (and two integration tests): "Kanban" instead of "Cline Kanban" in
  the startup message and the initial-commit message.
- `src/fs/locked-file-system.ts`, `src/cli.ts`: shutdown waits for lock operations still acquiring, holding or
  releasing a state lock before the process exits. Exiting mid-operation left a proper-lockfile lock directory
  behind, and the next start on the same home failed with "Lock file is already being held".
  `test/runtime/locked-file-system.test.ts` covers the wait; `test/integration/runtime-state-stream.integration.test.ts`
  checks that a stopped server leaves no lock behind.
- `test/runtime/server/middleware.test.ts`: the WebSocket upgrade tests pin the runtime host and port instead of
  inheriting `KANBAN_RUNTIME_HOST`/`KANBAN_RUNTIME_PORT` from the environment.
- `test/runtime/terminal/claude-workspace-trust.test.ts`: the concurrent-writer pre-trust test steps the other
  process at fixed points inside the compare-and-swap (change before the swap, stale overwrite after it) instead of
  racing a timed writer loop.
- `src/server/process-table.ts`, `src/server/process-reaper.ts`, `src/server/orphan-process-sweeper.ts`,
  `src/config/process-reaper-config.ts` (new), `src/server/task-trash-workflow.ts`, `src/server/runtime-server.ts`,
  `src/trpc/workspace-api.ts`, `src/trpc/projects-api.ts`, `src/trpc/runtime-api.ts`, `src/trpc/app-router.ts`,
  `src/core/api-contract.ts`, `src/workspace/task-worktree.ts`: process hygiene. Done, task delete and project
  removal terminate a card's processes (its session trees and everything whose cwd or executable is inside its
  worktree, including detached dev servers) before the worktree is deleted: SIGTERM, then SIGKILL after 5 s. A
  periodic sweep (`processes.reaper` in config.json: `enabled`, `intervalSec` default 300, `mode` `terminate` |
  `report`) reaps leftovers of cards that are Done on a readable board and reports the rest (missing cards,
  unreadable boards) and zombies. Shared processes are never signalled: the Cline hub daemon, and anything with
  incoming connections from outside the card or children in another worktree. Kernel threads are detected by
  PF_KTHREAD. An unreadable config.json, an unknown `mode` or a manual sweep while disabled only report. Linux
  only (/proc); a no-op elsewhere. The last sweep is exposed as `runtime.getProcessSweep` / `runtime.runProcessSweep`.
- `web-ui/src/components/process-sweep-panel.tsx`, `web-ui/src/runtime/use-process-sweep.ts` (new),
  `web-ui/src/components/debug-dialog.tsx`, `web-ui/src/runtime/runtime-config-query.ts`: the debug dialog shows the
  last process sweep (processes and RSS per card, reaped orphans, zombies) with a "Sweep now" button.
- `deploy/kanban-entrypoint.sh` (new), `deploy/Containerfile`, `docs/fork/container-lifecycle.md` (new),
  `test/integration/kanban-entrypoint.integration.test.ts` (new): the image's ENTRYPOINT runs Kanban as its child,
  starts `/root/.kanban/bin/kit boot` detached at every container start, and on every stop runs `kit prepare-restart`
  (bounded, 45 s default) before passing SIGTERM/SIGINT on; replaces node's `docker-entrypoint.sh`. The image adds
  `STOPSIGNAL SIGTERM` and `LABEL io.containers.autoupdate=registry`; the quadlet needs `StopTimeout=90`.
  `src/state/kanban-server-lock.ts` (comment), `test/runtime/server/process-reaper.test.ts`: the server is no longer
  PID 2 in the container; the reaper protects the entrypoint as the server's parent.
- `src/server/model-lists-route.ts`, `src/config/model-lists-config.ts`, `src/setup/cline-models-source.ts`,
  `src/commands/setup.ts` (new), `src/server/runtime-server.ts`, `src/cli.ts`, `src/state/kanban-home.ts`,
  `test/utilities/isolate-agent-config.ts`: model-lists route. `GET /api/model-lists/lemonade` serves Lemonade's
  model list filtered to downloaded models with every label in `models.lists.lemonade.requireLabels` (config.json;
  default `["tool-calling"]`, upstream `models.lists.lemonade.url`, default `http://localhost:13305`), in Cline's
  `modelsSourceUrl` shape, and 502 when Lemonade fails so Cline keeps its static list. It holds only model ids, so it
  is served ahead of the passcode gate (agent CLIs have no session). `kanban setup [--dry-run] [--origin <url>]`
  points the `lemonade` provider in Cline's `models.json` at the route (only when the URL is unset, the legacy kit's
  `127.0.0.1:13306` service or the route on another origin; a timestamped backup first). Replaces the legacy kit's
  model-lists service.
- `src/config/pipeline-config.ts`, `src/kits/` (`kit-schema.ts`, `resolve-kit.ts`, `policy.ts`, `tier-lookup.ts`,
  `kit-report.ts`, `apply-kit.ts`), `kits/default.json`, `kits/team.json`, `src/core/effective-agent.ts`,
  `src/commands/kit.ts`, `src/commands/config.ts`, `src/commands/workspace-target.ts` (new), `src/cli.ts`,
  `src/state/kanban-home.ts`, `package.json` (`files`): routing kits (plan step P3-1). Core pipeline settings
  (`pipeline.*`, `watchdog.*`, `orchestrator.*`, `models.*`, `agents.*`, `backups.*`, `workspaces.<id>.*` in
  config.json, zod with defaults); the kit schema; built-in kits `default` (no routing) and `team` (the dev-team
  kit's routing as data); user kits in `$KANBAN_HOME/kits/`; the resolver (workspace override > kit > `default`,
  nothing inherited from another workspace); `resolveEffectiveAgent`/`resolveEffectiveModel`; the routing-policy
  evaluator with the tier → model lookup; `kanban kit list|show|apply` and `kanban config show`. No behaviour
  change: nothing acts on these settings yet, and only `kanban kit show` calls the evaluator.
- `src/server/session-column-sync.ts` (new), `src/config/session-sync-config.ts` (new), `docs/fork/session-sync.md`
  (new), `src/cli.ts`, `src/server/runtime-server.ts`, `src/trpc/runtime-api.ts`, `src/core/api-contract.ts`,
  `src/terminal/agent-registry.ts`, `src/core/task-board-mutations.ts`, `src/server/task-trash-workflow.ts`,
  `web-ui/src/hooks/use-board-interactions.ts`, `web-ui/src/App.tsx`: session sync. The runtime, not the browser,
  moves a card between In Progress and Review when its session changes state (awaiting_review → Review, running →
  In Progress), with or without a browser open. Only a session summary newer than the card moves it. A Review
  card armed by auto-review stays in Review while its agent runs the commit/PR prompt. An interrupted session no
  longer moves its card to Done. `"sessionSync": false` in config.json (default on; read once at startup, so a
  restart applies it) brings back the browser's upstream moves. The runtime config response has
  `sessionSyncEnabled`.
- `.gitattributes` (new): `CHANGES-FORK.md` and `AGENTS.md` use `merge=union` (both are append-only), so two branches
  that both append an entry merge without a conflict.
- `src/terminal/cline-turn-outcome.ts`, `src/terminal/cline-session-files.ts`, `src/terminal/cline-turn-monitor.ts`,
  `src/config/cline-turn-detector-config.ts` (new), `src/config/pipeline-config.ts` (schema), `src/terminal/agent-session-adapters.ts`,
  `src/terminal/session-manager.ts`, `src/server/runtime-server.ts`, `src/state/kanban-home.ts` (comment), tests:
  Cline CLI turn-end detector. Some providers end a cline 3.x turn without the TaskComplete hook; the server reads
  Cline's session files and ends the turn in Kanban (hooks ingest `to_review`) on an idle final reply with a
  `STATUS:` line, a QA final line, a no-images rejection or bare provider error (2 min), or 5 quiet min after a
  bounce back to running. Ported from the legacy kit's column-sync. `agents.cline.turnDetector.mode` in config.json:
  `off` | `report` (default: log only, the legacy kit still does it) | `on`.
- `src/models/` (`bedrock-probe.ts`, `model-probe.ts`, `cline-providers.ts`, `card-provider-migration.ts`),
  `src/commands/models.ts`, `src/commands/runtime-trpc-client.ts` (new; the task command's tRPC client moved there),
  `src/commands/task.ts`, `src/cli.ts`, `src/state/kanban-home.ts`: `kanban models probe|providers` (plan step P3-3).
  `models probe <id…> [--list] [--refresh] [--provider bedrock|lemonade] [--region] [--json]` asks each model for a
  tool call through Bedrock Converse (us.* inference profile when listed, profiles cached in
  `<home>/data/models/bedrock-profiles.json`, xAI never probed; exit 1 unless all answer); `probeModel()` is the typed
  probe outage recovery will call (Bedrock tool call, Lemonade `/health`). `models providers [--for M] [--cleanup]
  [--migrate-cards] [--apply] [--workspace]` reports and removes deprecated provider workarounds in Cline's
  providers.json/models.json (Mantle endpoints and `models.providers.deprecated`; backup first; Codex reported only)
  and moves open cards off them with the same model. Read-only unless `--apply`; nothing runs on its own.
- `src/kits/dev-assignment.ts` (new), `src/commands/task.ts`, `src/core/api-contract.ts`, `src/trpc/app-router.ts`,
  `src/trpc/workspace-api.ts`, `src/state/kanban-home.ts`, `web-ui/src/hooks/use-kit-dev-assignment.ts` (new),
  `web-ui/src/hooks/use-task-editor.ts`, `web-ui/src/components/task-kit-assignment-hint.tsx` (new),
  `web-ui/src/components/task-create-dialog.tsx`, `web-ui/src/App.tsx`: the kit's `devAssignment` at card creation
  (plan step P3-5). When the creator sets no agent and no model, `kanban task create` stores the workspace kit's
  agent and model on the card (provider from the kit, else P3-3's `providerForModel`), and the create dialog preselects
  them (from tRPC `workspace.getDevAssignment`) with a "from kit `team`" hint. An explicit agent or model wins
  (`--agent-id default` too). No change on the `default` kit; with `workspaces.<id>.pipeline.shadow` the proposal
  is only logged. Proposals go to `data/<workspace>/dev-assignment.jsonl`.
- `src/pipeline/` (new: `engine.ts`, `worker.ts`, `worker-host.ts`, `worker-protocol.ts`, `pipeline-state.ts`,
  `decision-log.ts`, `events.ts`, `features.ts`, `work-probe.ts`), `src/commands/pipeline.ts` (new), `src/cli.ts`,
  `src/server/runtime-state-hub.ts`, `src/server/auto-review-reconciler.ts`, `src/server/session-column-sync.ts`
  (comment), `src/core/api-contract.ts`, `src/core/task-board-mutations.ts`, `src/commands/task.ts`,
  `src/config/pipeline-config.ts`, `src/kits/kit-schema.ts`, `src/state/kanban-home.ts`, `src/trpc/runtime-api.ts`,
  `web-ui/src/types/board.ts`, `web-ui/src/state/board-state.ts`, `web-ui/src/hooks/app-utils.tsx`,
  `web-ui/src/components/{board-card,task-create-dialog,task-inline-create-card}.tsx`, `web-ui/src/App.tsx`:
  pipeline skeleton (plan step P4-1). A supervised worker child process (`kanban pipeline worker`) runs only while
  a workspace has landing mode `qa`; it gets workspace snapshots from the state hub, asks the workspace's resolved
  kit (`qaPolicy`) about each submitted card's effective agent, and writes each decision to
  `data/<ws>/pipeline-decisions.jsonl` (`pipeline.shadow` marks them shadow). It acts on nothing yet. Per-card
  state is `data/<ws>/pipeline-state.json` (first load imports the legacy kit's `checks-state.json`, read-only).
  Event bus (`verdictRecorded`, `landed`, `reworkSent`, `escalated`) and feature registry for kit features (none
  registered yet). `kanban pipeline status`. Cards gain `role` (`dev` | `qa` | `triage` | `calibration`; `task create
  --role`; a non-dev card gets no kit `devAssignment`) and `autoReviewMode: "qa"` (offered in the UI only on landing `qa`). **Behaviour change:** the
  auto-review reconciler delivers its prompt to the agent the card's session runs on (`resolveEffectiveAgent`)
  instead of `card.agentId`, and never arms `qa`-mode or non-dev cards. Nothing changes for workspaces on landing
  `off` (every workspace without a config entry).
- `src/doctor/` (new), `src/commands/doctor.ts`, `src/commands/project.ts` (new), `src/commands/setup.ts`,
  `src/commands/config.ts`, `src/commands/kit.ts`, `src/cli.ts`, `src/projects/project-add.ts`,
  `src/projects/project-sections.ts`, `src/projects/agents-qa-section.ts`, `src/setup/machine-setup.ts`,
  `src/setup/run-setup.ts`, `src/setup/managed-section.ts`, `src/setup/claude-md-section.ts`, `src/setup/cline-rules.ts`,
  `src/setup/workspace-trust-report.ts`, `src/setup/cline-models-source.ts`, `src/config/import-kit.ts`,
  `src/config/legacy-kit-config.ts` (new), `src/config/pipeline-config.ts`, `src/state/kanban-home.ts`: the dev-team
  kit's machine and project commands (plan step P3-2). `kanban doctor [path] [--fix] [--deep]` (home, each project's
  kit and landing mode, Claude Code/Codex trust, managed sections, worktree pre-push hooks, setup drift, and the
  "one owner" check against the legacy kit's services and toggles; `--deep` checks agent CLIs, env, ssh key and Cline
  providers); `kanban project add <path> [--kit] [--landing] [--base] [--name] [--blurb] [--agents-md]` (default kit,
  landing off) and `kanban project sync`; `kanban setup` adds quiet npm settings, Cline rules and TUI notices, the
  Cline Bedrock provider entry, the CLAUDE.md `kanban` section (not while the legacy kit is installed) and agent trust
  for every project; `kanban config import-kit [--dry-run]` maps kit.config.json (QA projects → kit `team` with
  overrides, landing `qa`, shadow; every other project → `default`, landing `off`; top-level routing never copied
  onto a project). New core keys `orchestrator.wake.target` and `sessionSync.enabled` (default on; P2-1's top-level
  `sessionSync` boolean still reads the same, `src/config/session-sync-config.ts` reads it through the core schema,
  and `doctor --fix` / `import-kit` rewrite it). The one-owner check covers session sync and the Cline turn detector
  against the legacy column-sync. `src/models/cline-providers.ts` and `src/commands/models.ts`: the provider settings
  paths (`getProviderSettingsPaths`) are shared with `doctor --deep`, which reports P3-3's deprecated-provider scan.
  `docs/fork/session-sync.md`: the new key form. Nothing runs on its own: every command is explicit.
- `src/server/session-column-sync.ts`, `src/terminal/cline-turn-check.ts` (new, shared with
  `src/terminal/cline-turn-monitor.ts`), `src/cli.ts`, tests, `docs/fork/session-sync.md`: session sync no longer
  bounces an idle Cline CLI TUI's card out of Review (plan step P2-2b). Before it moves a Review card whose session
  says "running" back to In Progress, it reads Cline's session file when the card's effective agent is the Cline CLI
  and keeps the card in Review if `evaluateClineTurnEnd({ requireStatus: false })` says the turn is over.
  `agents.cline.turnDetector.mode`: `off` (no check), `report` (default: move as before, log what it would keep),
  `on` (keep in Review). Other agents unchanged.
- `test/runtime/kits/team-qa-routing.test.ts`, `team-parity.test.ts`, `team-qa-prompt.test.ts` (new) with fixtures
  in `test/runtime/kits/fixtures/legacy-team/` (a copy of the live kit.config.json, and what the legacy kit's
  `lib/qa-route.cjs` / `qa/qa-card.cjs` answered for a card set, regenerated by `generate.cjs` there): routing parity
  for the `team` kit (plan step P4-T1). `kits/team.json` needed no change: with foo's imported overrides (blurb,
  `qa.promptNotes.dbSetup`, `postLand` only) it answers dev assignment, QA routes, FAIL/conflict/STALLED/unchanged
  handling and PASS like the legacy kit. One known difference: Claude-built dev cards get QA (plan §12). The full QA prompt comparison
  runs since P4-3. `src/core/card-role.ts` (new),
  `src/pipeline/engine.ts`: a card with no `role` that carries the legacy kit's creation markers ("QA<n> <id>:",
  "QA-CAL …", "TRIAGE <id>:" titles, its QA/calibration/triage prompt intros) counts as a `qa`/`calibration`/`triage`
  card, so the pipeline never asks a kit to QA a legacy QA card. Cards with a `role` are unchanged.
- `src/pipeline/snapshots.ts`, `checks.ts`, `submission-stage.ts`, `qa-log.ts` (new), `src/pipeline/engine.ts`,
  `worker.ts`, `decision-log.ts`, `work-probe.ts`, `src/state/board-backups.ts` (new), `src/state/workspace-state.ts`,
  `src/state/kanban-home.ts`, `src/config/pipeline-config.ts`, tests: snapshots, scripted checks and board backups
  (plan step P4-2). On a landing-`qa` workspace the pipeline worker snapshots each submitted dev card to
  `refs/kanban/snapshots/<id>` (temp index, fixed `kanban@localhost` identity; shadow builds the commit but moves no
  ref), and a snapshot equal to its base is not submitted. Scripted checks run on the snapshot: off unless
  `workspaces.<id>.checks.enabled` is true, or unset with landing `qa` on a kit other than `default`; one run at a
  time for the whole worker, every step under `nice` (`pipeline.checks.niceness`, 10) with test runners capped at
  `pipeline.checks.maxWorkers` (2) and killed as a process group after `timeoutMin`; no `KANBAN_*` variables reach
  the project's scripts; results go to `data/<id>/qa-log.md`, the card's pipeline-state entry and the decision log.
  `pipeline.checks.allowScripts` is now a package list (npm 12 `allow-scripts`). Every board write also writes
  `backups/boards/<id>/board-latest.json` plus a timestamped copy every `backups.board.everyMin` (10), keeping `keep`
  (200); `backups.board.enabled` (default on) turns it off. `package.json`: `npm run lint` runs `biome check`
  (formatting and import order too, not only lint rules), so the checks and pre-commit catch unformatted files;
  `test/runtime/server/session-column-sync.test.ts` and `vitest.config.ts` reformatted.
- `web-ui/src/components/board-card.tsx`, `web-ui/src/components/board-card-task-id.tsx` (new): every board card
  shows its task id (e.g. `7ad4d`) at the right end of the agent/model row, also on cards without an agent/model.
  Clicking it copies the id and shows a "Copied <id>" toast without opening or dragging the card.
- `src/workspace/land.ts`, `src/server/task-landing-gate.ts`, `src/pipeline/hold.ts` (new), `src/core/card-role.ts`,
  `src/server/task-trash-workflow.ts`, `src/server/runtime-server.ts`, `src/cli.ts`, `src/core/api-contract.ts`,
  `src/core/api-validation.ts`, `src/commands/task.ts`, `src/pipeline/{engine,worker,worker-host,worker-protocol,features,pipeline-state,decision-log}.ts`,
  `src/doctor/one-owner-checks.ts`, `web-ui/src/components/{board-card,land-or-discard-dialog}.tsx`,
  `web-ui/src/hooks/{use-linked-backlog-task-actions,use-board-interactions,use-task-sessions}.ts`,
  `web-ui/src/stores/landing-mode-store.ts` (new), `web-ui/src/App.tsx`, `web-ui/{vite,vitest}.config.ts`,
  `web-ui/tsconfig.json`, tests: Kanban lands cards itself on landing mode `qa` (plan step P4-4). The Done workflow's
  done gate squash-lands a dev card's pre-land snapshot (P4-2's `refs/kanban/snapshots`) onto its base before Done
  (merge-tree pre-check; commit-tree + update-ref when the base isn't checked out, else `merge --squash` there with the
  user's edits stashed and restored by sha; postLand rules from the kit; index.lock retries). Done on such a card
  with work not on its base needs a choice: Approve & land (the Commit / Open PR buttons on those cards,
  `kanban task approve`, `task done --land`) or discard (`task done --discard`); without one the move is refused and
  the board asks "land or discard?". A conflict keeps the card where it is. The hold (`onPass → hold`, recorded in
  pipeline-state) blocks Done until `releaseHold()` lands or discards it (optional `preserve/*` tag); the pipeline
  worker asks the server to finish cards over a new `finishTask` IPC request, and lands reach kit features as the
  `landed` event. Legacy kit QA/calibration/TRIAGE cards without a `role` (P4-T1's `resolveCardRole` markers) are
  never gated. Shadow workspaces only log what would happen; landing `off`/`commit`/`pr` and workspaces without a
  config entry are unchanged. `kanban doctor` fails when Kanban lands a project the legacy autoland still
  watches.
- `src/pipeline/watchdog/` (new: `watchdog.ts`, `stalls.ts`, `prompt-watch.ts`, `attention.ts`, `wake.ts`,
  `headless-run.ts`, `wake-requests.ts`, `pid-pressure.ts`, `prune-done.ts`, `watchdog-state.ts`, `workspace-data.ts`,
  `actions.ts`), `src/server/watchdog-actions.ts`, `src/terminal/orchestrator-agents.ts`,
  `src/state/board-restore.ts`, `src/state/board-backups.ts` (`getLatestBoardBackupPath`), `src/commands/{orchestrator,board}.ts` (new), `src/pipeline/{worker,worker-host,
  worker-protocol,features,decision-log,engine}.ts`, `src/server/runtime-server.ts`, `src/cli.ts`,
  `src/config/pipeline-config.ts`, `src/state/kanban-home.ts`, `src/doctor/one-owner-checks.ts`: the watchdog (plan
  step P4-7, port of the legacy kit's review-watch). It runs in the pipeline worker on `watchdog.intervalSec` and
  acts only through requests to the server. It finds stalls (Review with no QA, QA/TRIAGE stuck, dead sessions: one
  continue, then a wake), escalations, PID pressure (flags, an orphan-process sweep, Esc at brownout), an idle
  pipeline, open orchestrator-plan steps and cards stuck on a trust, startup or permission prompt. It writes
  `data/<ws>/ATTENTION.md` and wakes the orchestrator: the agent selected in Kanban settings, in
  `createHomeAgentSessionId(<orchestrator.wake.target or ws>, <agent>)`. It never starts two orchestrators: it types
  into a live sidebar, queues for a running headless run, and otherwise starts a headless run (`claude -p`/`codex
  exec`, lock, live-session check, timeout, follow-ups) or the sidebar session server-side. It never leaves zero.
  Also: the hourly prune of old Done cards and a job runner for kit features' periodic jobs. New CLI:
  `kanban orchestrator wake <issue> [--when-card-done <id> | --when-model-up <m>]`, `kanban board prune-done
  [--days] [--dry-run]`, `kanban board restore <ws> [backup]`. New setting `watchdog.mode`: `off` (default, so
  review-watch keeps the pod), `report` (decisions to `data/<ws>/watchdog-decisions.jsonl` only) or `on`. `kanban
  doctor` fails `on` while review-watch runs. Workspaces on landing `off` (the `default` kit) get only the
  stuck-prompt check. Roles come from P4-T1's `resolveCardRole` (legacy kit cards by their markers), plus
  calibration-run ids from `data/<ws>/calibration/*/state.json`.
- `src/kits/team/` (new: `bench/aws-prices.ts`, `prices.ts`, `price-sync.ts`, `price-sync-job.ts`, `card-metrics.ts`,
  `card-locator.ts`, `bench-reset.ts`, `bench-feature.ts`, `scoreboard/*`, `features.ts`), `src/commands/bench.ts`,
  `src/commands/model-prices.ts` (new), `src/commands/models.ts`, `src/cli.ts`, `src/pipeline/worker.ts`,
  `src/pipeline/events.ts`, `src/pipeline/features.ts`, `src/state/kanban-home.ts`, `assets/prices.default.json`
  (new): the team kit's scoreboard, bench and prices (plan step P4-T2, ported from the legacy kit's `bench/` and
  `lib/aws-prices.cjs`). The `scoreboard` feature (registered in the pipeline worker; it runs only where a
  workspace's kit lists it, so never on `default`) appends a line to `data/<ws>/scoreboard.jsonl` per
  `verdictRecorded`, `escalated` and Approve & land event and rebuilds `scoreboard.md`; nothing emits those events
  yet (P4-3/P4-4/P4-5), so it changes nothing today. `verdictRecorded` gains an optional `report` (the rest of the
  QA outbox: scores, visual, benchmark) and `escalated` an optional `round`. New commands: `kanban bench
  metrics|record-verdict|scoreboard|reset` and `kanban models prices sync [--apply|--check] [--offline]` (public AWS
  Price List; writes only `data/prices/`). Card metrics read the price table from `data/prices/prices.json`, else the
  legacy kit's `bench/prices.json`, else the seed. The `bench` feature registers the daily price check
  (`--check`) as a feature job (`bench:prices-check`, once a day machine-wide); the watchdog runs it only in
  `watchdog.mode: "on"`, which `kanban doctor` fails while the legacy kit's review-watch (its PRICE_SYNC) still runs.
- `src/pipeline/qa-gate.ts`, `qa-prompt.ts`, `qa-verdict.ts`, `qa-preview.ts`, `qa-shot.ts`, `scratch-processes.ts`,
  `actions.ts` (new), `src/server/pipeline-actions.ts` (new), `src/commands/qa.ts` (new),
  `src/pipeline/{engine,worker,worker-host,worker-protocol,decision-log,qa-log}.ts`, `src/server/runtime-server.ts`,
  `src/cli.ts`, `src/core/{api-contract,task-board-mutations,card-role}.ts`, `src/kits/kit-schema.ts`,
  `src/config/{pipeline-config,import-kit}.ts`, `src/state/kanban-home.ts`, `web-ui/src/types/board.ts`,
  `web-ui/src/state/board-state.ts`: the QA gate (plan step P4-3). On a workspace with landing `qa` and shadow off, a
  submitted dev card (snapshotted by the submission stage) whose kit answers `qaPolicy: qa` gets one QA card per
  snapshot: `role: "qa"`, new card field `reviewsTaskId`, the kit's QA agent and model, and the QA prompt (the legacy
  kit's QA v4 text around the kit's prompt parts, word for word equal to `qa-card.cjs`'s for foo). QA cards start
  oldest first within `pipeline.qa.slots` (machine-wide); a finished QA card's
  `<pipeline.qa.outboxRoot>/<qa id>/verdict.json` is recorded in `data/<ws>/qa-log.md`,
  `data/<ws>/qa-artifacts/<dev>/r<n>/` and the dev card's pipeline state, emits `verdictRecorded`, stops the scratch
  servers and moves the QA card to Done (`finishTask`, never landed). Missing/invalid verdicts are nudged
  (`maxNudges`, through the watchdog's `deliverInput`) after `verdictGraceSec`, then STALLED; PASS with visual
  blocked is STALLED. A PASS for the card's current snapshot goes to the kit's `onPass` (`decideOnPass`) and, unless
  held, is landed through the Done workflow (trigger `pipeline`); a failed land is recorded once and left in Review
  (FAIL and conflicts are P4-5's). Kit `qa.preview` is now `{ pidFile, start, stop }` (started before QA, stopped
  after `pipeline.qa.previewIdleMin` idle minutes only if it is still the pid the gate started; `config import-kit`
  maps the legacy object). The QA gate's `createTask`/`startTask` travel as worker `request`s next to the
  watchdog's; the server refuses them for workspaces not on landing `qa`. `kanban qa shot` (port of
  `qa/qa-shot.cjs`; Playwright from the scratch copy). Nothing changes for workspaces on landing `off`/`commit`/`pr`
  or in shadow (shadow only logs).
- `src/kits/team/calibration/` (new: `calibration-spec.ts`, `calibration-state.ts`, `calibration-prompt.ts`,
  `calibration-runner.ts`), `src/commands/bench-calibrate.ts` (new), `src/commands/bench.ts`, `src/commands/task.ts`,
  `src/terminal/agent-run-signals.ts` (new), `src/terminal/cline-session-files.ts`,
  `src/terminal/agent-session-adapters.ts`, `src/pipeline/qa-verdict.ts`, `src/pipeline/watchdog/workspace-data.ts`,
  `src/kits/policy.ts`, `src/state/kanban-home.ts`: QA calibration (plan step P4-T4, ported from the legacy kit's
  `qa/calibrate.mjs`). `kanban bench calibrate <spec> [--project] [--foreground] [--print] [--force]` runs the same
  QA review on fixed snapshots by several QA models: one `role: "calibration"` card per set × model (title
  `QA-CAL …`, the pipeline's QA prompt with a calibration intro on `refs/kanban/calibration/<name>-<set>`), a wave
  of `parallel` runs at a time, set by set. It detaches (log `<home>/logs/calibrate.log`), keeps resumable state in
  `data/<ws>/calibration/<name>/state.json` (the legacy kit's format plus `version`/`finishedAt`; one runner per
  calibration, `runner.pid`), nudges cards that stop without a verdict, ends runs DNF on timeout, cost cap,
  tool-call loop, no native tool calls, a signed-out agent or a card moved by hand, stops scratch servers, moves each
  card to Done (discarded), writes `results.json`/`results.md` and queues an orchestrator wake when done. It talks to
  the running server like `kanban task …`, refuses a workspace whose kit doesn't list the `calibration` feature
  (`--force`), and never writes the scoreboard. Per-agent run facts (Cline session messages, Copilot login and
  events) live in `src/terminal/agent-run-signals.ts`. prune-done now treats a calibration as finished by its
  state's `finishedAt` (legacy states: `results.md`, as before). Nothing runs unless someone starts it.
- `src/pipeline/recovery.ts`, `recovery-detect.ts`, `recovery-prompts.ts`, `recovery-stage.ts`, `recovery-runtime.ts`,
  `restart-recovery.ts`, `provider-capacity.ts`, `wip-tag.ts` (new), `src/pipeline/engine.ts`, `worker.ts`,
  `worker-host.ts`, `worker-protocol.ts`, `actions.ts`, `decision-log.ts`, `src/server/pipeline-actions.ts`, `src/cli.ts`, `src/commands/restart.ts`, `src/commands/task-recovery.ts` (new),
  `src/commands/task.ts`, `src/commands/models.ts`, `src/models/model-probe-setup.ts` (new),
  `src/terminal/agent-session-adapters.ts`, `src/terminal/cline-session-files.ts`, `src/terminal/session-manager.ts`,
  `src/config/pipeline-config.ts`, `src/state/kanban-home.ts`, `src/doctor/one-owner-checks.ts`, tests: pipeline
  recovery (plan step P4-6), ported from the legacy kit's autoland. Crash nudges, premature-stop continues (empty
  reply, output cap, "no images", announcement), poisoned-history `/clear` + resend (with the overflow culprit and a
  cleanup of gitignored reports), provider-error backoff retries, the outage hold with model probes, hung-request
  cancel (Esc), provider capacity (`models.providerCapacity.<id>.maxLoadedModels`), and restart recovery (orphans
  after a Kanban restart are resumed one at a time with a WIP tag; the restart manifest). New core key
  `pipeline.recovery.mode` (`off` | `report` | `on`, default `report`: decide and log on landing-`qa` workspaces,
  act on nothing) plus `resumeGapSec` and `nudgeCheckSec`; with `on` it acts on every workspace with
  `workspaces.<id>.recovery.enabled` and no `pipeline.shadow`, through the worker's requests (the watchdog's
  `deliverInput` / `interrupt`, and a new card action `resumeTask`, which the host accepts for any workspace the worker
  has while `createTask`/`startTask` stay landing-`qa` only, and which never starts over a live session). Recovery runs
  before the QA gate, and the engine skips the snapshot and QA gate for a Review card recovery holds. Premature-stop
  continues run only on landing-`qa` workspaces. Budgets restart at the QA gate's newest verdict. The server records
  its start in `<home>/run/server-start.json` (reading the previous record first), and a restart manifest is used
  only when the server that wrote it is the one right before this start; any other is dropped, never replayed. Agents declare `/clear` and the cancel key in their adapter (`recovery`). New commands `kanban restart prepare|recover [--workspace] [--dry-run]` and
  `kanban task send|resume|restart-fresh`. `kanban doctor`'s one-owner check gets a recovery row (Kanban vs autoland).
- `src/pipeline/rework.ts`, `rework-text.ts`, `rework-notes.ts`, `rework-state.ts`, `handback.ts` (new),
  `src/pipeline/recovery.ts`, `src/server/runtime-server.ts`,
  `src/pipeline/{actions,worker,worker-protocol,worker-host,qa-gate,qa-log,hold,decision-log}.ts`,
  `src/pipeline/watchdog/{stalls,watchdog,attention}.ts`, `src/server/pipeline-actions.ts`, `src/commands/task.ts`,
  `src/terminal/{cline-session-files,orchestrator-agents}.ts`: the rework loop (plan step P4-5). On a workspace with
  landing `qa` and shadow off, a dev card whose newest QA verdict is FAIL or STALLED, whose PASS did not land because
  of a merge conflict (the QA gate now keeps the landing outcome on `qaPass.landing`), or whose rework came back with
  an unchanged snapshot is acted on once (`qaflow.handled[]`). At `pipeline.rework.maxFailRounds` FAIL rounds (land
  conflicts count; plus each handback's extra rounds) the core escalates to the orchestrator whatever the kit says;
  below it the kit's `onFail` decides. `rework`: the REWORK section goes into the card prompt before FINAL STEP, the
  QA write-up and artifacts into `.qa/r<N>/` in the worktree (git-ignored via `info/exclude`), and the section is
  typed into the card's session (after the agent's clear command, `/clear` for Cline and Claude Code, with the whole
  prompt when the session is past `clearAfterTurns`/`clearAfterTokens`; only Cline sessions are measured). No session
  to type into: a fresh session from the card prompt on the same agent, only when the card pins its model (P4-6's
  `resumeTask`, which now takes an optional `prompt`, default the card's own). A rework
  whose session ran on another agent or model than the card names is refused (→ escalate). A started-check restarts
  a rework not seen running after 2 min once (`resumeTask` with `replaceLive`: a live idle session is stopped first and
  the card moves only once a new session started), then escalates. Recovery leaves a fresh rework not yet started to
  the started-check and counts its budgets from `qaflow.lastReworkAt` too; the rework stage leaves a card recovery
  holds alone. Escalation to the orchestrator: `qaflow.escalated`,
  `## ESCALATE` in the QA log, the card to Backlog as `BLOCKED: …` (the watchdog's ATTENTION.md and wake already read
  `qaflow.escalated`); to a model: the work is tagged `preserve/<id>-<model>` and a sibling card takes the task over
  on that model (left in Backlog when `requireApproval`). `runoff` is refused (escalated to the orchestrator) until
  P4-T3's `runoffs` feature can hold the racing siblings' PASSes, so a sibling and the original can't both land. A
  rework a crashed worker left `pending` is sent again from its recorded trigger (or counted as sent when the card
  ran meanwhile). `stop`: `qaflow.stopped`, one
  ATTENTION.md line and a wake (watchdog). Events `reworkSent` and `escalated` are emitted. New worker requests
  `updateTask`, `blockTask`. New command `kanban task handback --task-id <id> --note … [--extra-rounds
  N] [--by NAME]` (append-only, under the pipeline state's lock; drops the `BLOCKED: ` prefix; closes the rework the escalation came from, so the started-check doesn't escalate it
  again; with extra rounds the card goes to Review and its last FAIL is reworked once, except after a STALLED QA
  round, which it says it won't rework). Nothing changes for workspaces on landing
  `off`/`commit`/`pr`, in shadow, or on the `default` kit (no QA, so no verdicts).
- `src/terminal/agent-session-adapters.ts`, `test/runtime/terminal/agent-session-adapters.test.ts`: Copilot cards in
  autonomous mode start in autopilot (`--autopilot`, plus `--allow-all-urls`, without which Copilot 1.0.92 blocks the
  launch on an "Enable autopilot mode" permission dialog), as a trial at the user's request (2026-10-07). A user's
  `--autopilot` / `--mode` / `--max-autopilot-continues` is kept; plan mode is unchanged.
- `src/terminal/review-settle.ts` (new), `src/core/api-contract.ts`, `src/terminal/session-manager.ts`,
  `src/config/pipeline-config.ts`, `src/config/session-sync-config.ts`, `src/cli.ts`, `src/pipeline/engine.ts`,
  `qa-gate.ts`, `rework.ts`, `recovery.ts`, `recovery-stage.ts`, `worker-host.ts`,
  `src/server/auto-review-reconciler.ts`, `docs/fork/session-sync.md` (and tests): the review settle rule. Code that
  treats Review as a finished turn (the pipeline's snapshot and QA queue, QA ingest and PASS landing, the rework
  stage's returned check, recovery's Review nudges, auto-review's commit prompt) acts only once the session has been
  in Review with no new state change or hook activity for `sessionSync.reviewSettleSec` (default 12 s, `0` = off),
  through one helper, `isReviewSettled()`. Found by the Copilot autopilot trial: each continuation flips the card
  to Review for ~100 ms, and a background shell can start a new turn ~6 s after the final stop, so QA snapshotted
  half-done work and auto-review typed into a working agent. Session summaries carry `stateChangedAt`; the
  pipeline worker host sends a snapshot once a Review has settled. The column move itself is unchanged.
- `src/guardrails/` (new), `src/terminal/agent-guardrails.ts`, `src/terminal/cline-guard.ts` (new),
  `src/terminal/agent-session-adapters.ts`, `src/terminal/session-manager.ts`, `src/trpc/runtime-api.ts`,
  `src/config/pipeline-config.ts`, `src/commands/hooks.ts`, `src/workspace/task-worktree.ts`,
  `src/doctor/guardrail-checks.ts` (new), `src/doctor/run-doctor.ts`, `src/doctor/doctor-report.ts`, tests: task-card
  guardrails. A core `guardrails` section (on by default; per workspace `workspaces.<id>.guardrails`) lists commands
  task-card agents must never run (any `git push`, `filter-branch`/`filter-repo`, `update-ref`/`branch -D|-f|-m`/
  `switch -C`/`checkout -B` on a shared branch, podman/docker/systemctl restart/stop/rm, `kanban home migrate`;
  card-local rebases and resets stay allowed) and keeps their writes in their worktree. Each adapter applies it with
  its CLI's own mechanism: Claude Code `permissions.deny` in a per-card `--settings` file; Codex `forbidden` execpolicy
  rules in `<worktree>/.codex/rules/` (they hold under `--dangerously-bypass-approvals-and-sandbox`) and the
  `workspace-write` sandbox where Codex's sandbox runs on the host; Cline a `kanban hooks cline-guard` step in
  Kanban's PreToolUse hook (`cancel`); Copilot `--deny-tool` `shell(...)` and `write(<dir>/**)` (it keeps
  `--allow-all-paths`, which autopilot needs). What a CLI can't enforce goes into a short launch prompt note.
  `kanban doctor` shows a row per installed agent. The orchestrator (home-agent sidebar session, headless wakes) is
  exempt.
