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
- Package publishing (docs/fork/github-auth.md, `RELEASE_WORKFLOW.md`): the package is `@vombor/kanban` on GitHub
  Packages (`package.json` `name`, `publishConfig.registry`; `provenance` and `access` dropped, GitHub Packages has
  no npm provenance and links the package's visibility to the repository). `.github/workflows/publish.yml` runs on
  `v*` tags (and by hand for an existing tag), publishes only to GitHub Packages (`next` for prerelease versions,
  `latest` otherwise) and creates the GitHub release, both with the repo secret `GH_PAT`; upstream's npmjs OIDC
  trusted publishing and the Slack post are removed. `.github/scripts/extract-changelog-entry.mjs` no longer matches
  `0.1.70` against a `0.1.70-fork.N` heading. `.github/workflows/image.yml` logs in to GHCR with `GH_PAT` and packs
  the scoped tarball. `src/update/` checks for updates of `@vombor/kanban` on GitHub Packages with the token from
  `~/.npmrc` (else `GH_TOKEN`), and quietly skips the check without one; `src/prompts/append-system-prompt.ts` uses
  the scoped name. `README.md`, `RELEASE_WORKFLOW.md` and the release command describe installing and releasing.
- GitHub PAT in the container: `deploy/kanban-entrypoint.sh` turns `GH_TOKEN` into an npm `${GH_TOKEN}` reference for
  `@vombor` and gh's git credential helper; `deploy/Containerfile`, `docs/fork/container-lifecycle.md` describe it.
  `src/pipeline/checks.ts` hides `GH_TOKEN`/`GITHUB_TOKEN`/`COPILOT_GITHUB_TOKEN`/`AWS_BEARER_TOKEN_BEDROCK` from a
  project's checks and `scripts/secret-guard.sh` knows their values. Copilot launches
  (`src/terminal/agent-session-adapters.ts`) keep the env as is, so Copilot runs on the container's
  `COPILOT_GITHUB_TOKEN` (podman `Secret=...,type=env,target=COPILOT_GITHUB_TOKEN`), which it prefers over
  `GH_TOKEN`/`GITHUB_TOKEN` and its login; `src/terminal/agent-run-signals.ts` counts that token as signed in, and
  `src/doctor/github-auth-checks.ts` names the credential Copilot runs on and warns without a token or login.
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
- `src/kits/team/runoffs/` (new: `runoffs-store.ts`, `runoff-decision.ts`, `runoffs-feature.ts`, `runoff-create.ts`),
  `src/kits/team/tiers/tiers-report.ts` (new), `src/commands/bench-runoff.ts` (new), `src/kits/team/features.ts`,
  `src/kits/policy.ts`, `src/pipeline/{features,hold,qa-gate,worker}.ts`, `src/pipeline/watchdog/stalls.ts`,
  `src/commands/{bench,task}.ts`: the team kit's runoffs and tiers (plan step P4-T3, ported from the legacy kit's
  runoff hold and `decideRunoffs` in `kanban-autoland.mjs`). The `runoffs` feature answers `onPass → hold` for a card
  in an open runoff of `data/<ws>/runoffs.json` (the legacy format), and on each pipeline evaluation (landing `qa`,
  not shadow) decides a runoff once every card has a held PASS for its current snapshot or is escalated: mean QA
  score, then fewer FAIL rounds, then lower cost. The winner lands and losers are tagged `preserve/<id>-<model>` and
  discarded, both through `releaseHold` (the Done workflow). `benchOnly` lands nothing. A runoff with cards trashed
  or deleted by hand is only closed (winner = the only trashed card that held a PASS). Features can now answer
  `onPass` before the kit (a feature that fails to answer leaves the PASS for the next evaluation, never lands it),
  run per-evaluation ticks and append to the QA log. The QA gate re-asks `onPass` for a held card's newer PASS
  (refreshing the hold) instead of skipping it, and a held PASS for the current snapshot is no review stall.
  `escalate.to: { tier }` is answered with the tier's model only when the kit lists the `tiers` feature (else the
  orchestrator). New commands: `kanban bench runoff create <name> (--model … | --tier …) (--prompt … | --from <id>)
  [--bench-only] [--start]` (refuses a kit without `runoffs`), `kanban bench runoff status [name] [--all]`,
  `kanban bench tiers`. Nothing changes for workspaces whose kit doesn't list these features (`default`), or that
  are not on landing `qa`, or in shadow.
  With P4-5 in: the kit's `onFail.runoff` answer now races sibling cards (one per model, prompt = the task plus what
  QA found) while the failed card is reworked as usual. The rework stage records the group with the `runoffs`
  feature (`PipelineRunoffGroups`, src/pipeline/features.ts) before it creates a sibling, so neither the failed card
  nor a sibling can land before the runoff is decided; without the feature the answer still escalates, a card that
  already races gets a plain rework, and a racing card's escalation to a model goes to the orchestrator. A sibling
  that can't start is discarded and dropped from the group (or parked as escalated BLOCKED). Siblings are never
  linked on the board (a link restarted a BLOCKED original after its sibling landed), and the engine and the QA gate
  never QA or land an escalated card. At `pipeline.rework.maxFailRounds` the core now asks the kit first and keeps
  its escalation target (team's `escalate.to: { tier }` opt-in works with the default cap). No hold is a dead end:
  decisions are written with their pending actions and resumed after a crash, failing releases are retried 3 times,
  a winner whose land conflicts goes down the rework conflict path, a runoff closed by hand unholds its other cards,
  the review-stall exemption covers only open runoffs, and `kanban task release-hold --task-id <id> --land|--discard
  [--tag]` is the human way out (logged). `kanban task handback` reopens a runoff decided with no winner and refuses a
  card of a runoff that has a winner (or is `benchOnly`); `kanban bench runoff create` records the group before
  creating its cards. Fixes from P4-5's review: until the started-check restarts a rework it belongs to the started
  check whatever its age, then for one window from the restart (`isReworkAwaitingStart`), and the engine header names
  recovery.
- `src/guardrails/command-patterns.ts`, `src/guardrails/task-guardrails.ts`, `src/terminal/agent-guardrails.ts`,
  `src/terminal/claude-guard.ts` (new), `src/terminal/cline-guard.ts`, `src/terminal/agent-session-adapters.ts`,
  `src/commands/hooks.ts`, `src/trpc/runtime-api.ts`, `src/server/runtime-server.ts`, `src/config/pipeline-config.ts`,
  `src/doctor/guardrail-checks.ts`, tests: guardrail review fixes. Option slots and `{shared}` in a deny pattern now
  match any word after the subcommand (`git update-ref -m msg refs/heads/main X`, `git branch -q -D main`), and
  the matcher sees through `timeout`/`nice`/`setsid`/`stdbuf` and wrapper option values. Claude Code's deny rules
  also cover git's global options (`git -* push *`) and every order of the floating slots, and Claude cards get a
  PreToolUse hook on Bash (`kanban hooks claude-guard`) with Kanban's matcher for the forms rules can't express.
  The PR git action (a card whose `autoReviewMode` is `pr` at launch, `guardrails.prCardPush: own-branch` by
  default) may push its own branch, named explicitly, never a shared one, on Claude Code and Cline; Codex and
  Copilot keep the push deny, and `kanban doctor` says so, as it says the Commit action's conflict step in the base
  worktree is a denied write. Kanban's `.cline/hooks` files are git-excluded (the PreToolUse one embeds the card's
  policy); a stale `.codex/rules/kanban-guardrails.rules` is removed when guardrails are off; a Claude card's
  `hooks/claude/cards/<id>.json` is removed on Done; the Cline guard decides on a write's resolved path against
  roots as given and resolved; Codex's workspace-write sandbox may write `~/.npm`, `~/.cache` and the other package
  caches; the doctor shows per-workspace guardrail overrides and caps its Codex sandbox probe at 5 s (a timed-out
  probe is no longer cached as "no sandbox").
- `scripts/pipeline-shadow-diff.ts` (new), `src/pipeline/shadow-diff/` (new: `legacy-autoland-log.ts`, `shadow-diff.ts`,
  `shadow-diff-report.ts`, `load-shadow-diff-inputs.ts`, `run-shadow-diff.ts`), `src/state/kanban-home.ts`
  (`getLegacyKitAutolandLogPath`), `tsconfig.json` (typechecks `scripts/**/*.ts`), `package.json` (`npm run
  shadow-diff`; lint covers the script), `docs/team/WORKFLOW.md`, `RUNBOOK.md`, `CONFIG.md`, `KITS.md` (new), tests: the
  cutover's shadow diff and the team-workflow docs (plan step P4-8). The script compares, read-only, what the pipeline
  decided on a shadow workspace (`pipeline-decisions.jsonl`, `dev-assignment.jsonl`) with what the legacy kit's
  autoland did (its log, the board's QA cards, `checks-state.json` resets): QA routing, the kit's `onFail` answer for
  each legacy FAIL/STALLED/conflict (asked offline, since a shadow pipeline has no verdicts of its own), recovery
  nudges and holds, restart orphans, and dev-assignment proposals. Exit 0 when nothing is unexplained (plan
  differences such as QA for Claude-built cards are marked KNOWN). Replaces the legacy kit's `test/equivalence.sh`
  for the port. The docs rewrite the legacy kit's WORKFLOW/RUNBOOK/CONFIG for the core and add the kit schema, the
  `default` and `team` kits and how to write a user kit. Nothing runs on its own.
- `src/guardrails/command-patterns.ts`, `src/guardrails/task-guardrails.ts`, `src/terminal/agent-guardrails.ts`,
  `src/config/pipeline-config.ts`, `src/workspace/task-launch-files.ts` (new), `src/workspace/task-worktree.ts`,
  `src/terminal/agent-session-adapters.ts`, `src/server/runtime-server.ts`,
  `web-ui/src/git-actions/build-task-git-action-prompt.ts`, tests: guardrail follow-ups. A refspec destination that
  is a shared branch or ends in `/<shared>` (after stripping `refs/` and `heads/`) counts as shared, so a PR card's
  `git push origin card:heads/main` (git's DWIM for the remote's main) is denied by the Claude and Cline guards and
  Claude's deny rules. New `{shared-dest}` pattern slot and default rules `git fetch {shared-dest}` / `git pull
  {shared-dest}`: `git fetch . card:main` and `git fetch origin main:main` no longer fast-forward a local shared
  branch, while `git fetch origin main` stays allowed (Claude and Cline enforce it; Codex and Copilot can't without
  denying every fetch, so their cards get it in the prompt note). A Claude card's `hooks/claude/cards/<id>.json` is
  removed by `deleteTaskWorktree`, so task delete and project removal clean it up as well as Done. A timed-out Codex
  sandbox probe is cached for 10 minutes (for callers whose own timeout is no longer), so a hanging `codex sandbox`
  no longer delays every Codex launch. The Make PR click's prompt says the guardrails may block `git push` for the
  card (push permission is decided at launch from the card's git action) and that the user lets it push by setting
  the git action to PR (`kanban task update --auto-review-mode pr`) and restarting its session; the guard hooks'
  plain push block says the same.
- `deploy/kanban-entrypoint.sh`, `deploy/Containerfile` (comment), `docs/fork/container-lifecycle.md`,
  `docs/team/RUNBOOK.md`, `docs/team/WORKFLOW.md`, `test/integration/kanban-entrypoint.integration.test.ts`: on every
  container stop the entrypoint also runs `kanban restart prepare` (all workspaces), after the legacy kit's
  `kit prepare-restart` and before Kanban gets the signal, bounded by `KANBAN_RESTART_PREPARE_TIMEOUT` (default 20 s,
  inside the quadlet's StopTimeout=90) and pointed at the command's `--port`/`--host`/`--home`/`--https`. A failing,
  hung or missing command, or a Kanban already down, logs one line and never holds up the stop. It no longer has to
  be run by hand before a planned container restart.
- `src/state/pid-pressure-flags.ts` (new), `src/pipeline/worker-host.ts`, `engine.ts` (`pidPressure` in the snapshot),
  `qa-gate.ts`, `recovery-stage.ts`, `src/commands/bench-calibrate.ts`, `docs/team/RUNBOOK.md`, `WORKFLOW.md`, tests: the
  legacy autoland's PID pressure hold. While a PID pressure flag is up (the watchdog's, or the legacy kit's review-watch's
  while its config exists), the QA gate creates and starts no QA cards and restart recovery waits before each resume,
  each hold logged once; both go on when it clears. One reader serves the worker host (every snapshot) and calibration.
- `src/terminal/orchestrator-agents.ts` (`agentContinuesConversationOnResume`), `src/pipeline/recovery-prompts.ts`
  (`RESTART_RESUME_NOTE`, `buildRestartResumeLaunch`), `recovery-stage.ts`, `actions.ts`, `worker.ts`, `rework.ts`
  (comment), `src/server/pipeline-actions.ts`, `src/commands/task-recovery.ts`, `src/terminal/session-manager.ts`,
  tests: restart recovery and `kanban task resume` continue a Claude card's conversation (`resumeFromTrash`, i.e.
  `claude --continue`) with the legacy kit's resume note as the launch prompt instead of starting a new session with
  the whole card prompt (ported from kit main a2b4695 `lib/resume.mjs` resumeClaude). The card's stored prompt never
  changes. Other agents, Cline included, still restart fresh with the card prompt (+ the WIP note), because their
  "resume + launch prompt" behaviour isn't verified. The rework started-check's `replaceLive` restart stays a fresh
  session from the reworked card prompt. A `resumeFromTrash` start with a launch prompt now begins `running`, not
  `awaiting_review`.
- `src/pipeline/shadow-diff/shadow-diff.ts`, `legacy-autoland-log.ts`, `docs/team/RUNBOOK.md` (P5-1 shadow day): the restart
  comparison pairs the two sides' times for one Kanban start within 10 s (autoland reads /proc, the server records
  `Date.now() - process.uptime()` after binding its port, ~0.5 s apart), reports autoland's phantom starts (a short-lived
  `kanban --port` process it took for the server, which it leaves again 15 s later) as KNOWN, and counts a legacy start
  without orphans as SAME while the pipeline worker was watching (the pipeline logs only starts with orphans).
  Tests: the shadow-diff unit tests, the CLI create → `dev-assignment.jsonl` → shadow-diff path, and a second
  `kanban --port` launch leaving `run/server-start.json` alone.
- `src/kits/browser-dev-assignment-log.ts` (new), `src/kits/dev-assignment.ts` (`source`, `getDevAssignmentLogPath`),
  `src/state/workspace-state.ts` (`saveWorkspaceStateReportingAddedCards`), `src/trpc/workspace-api.ts`,
  `src/pipeline/shadow-diff/load-shadow-diff-inputs.ts`, `docs/team/RUNBOOK.md`, tests (P5-1 shadow day follow-up): cards
  made in the browser are now logged to `dev-assignment.jsonl` too. `workspace.saveState` reports the cards a save
  added (compared with the stored board under the board lock) and the server logs each new dev card once per task id,
  with the CLI's entry shape plus `source: "browser"` (the CLI's lines now say `source: "cli"`), so the shadow diff
  compares them unchanged. Cards the CLI, pipeline, calibration or runoffs write are already stored and never logged
  as browser cards; non-dev roles and `default`-kit workspaces log nothing.
- `src/pipeline/legacy-import.ts`, `src/kits/team/runoffs/runoffs-import.ts`, `src/kits/team/scoreboard/scoreboard-import.ts`
  (new), `src/pipeline/pipeline-state.ts` (`mergeLegacyCardEntries`), `src/config/legacy-kit-config.ts`
  (`resolveLegacyKitProjectFiles`), `src/state/kanban-home.ts`, `src/commands/pipeline.ts`, `src/state/pid-pressure-flags.ts`,
  `test/utilities/vitest-setup.ts`, `docs/team/RUNBOOK.md`, tests (P5-2 foo switch): `kanban pipeline import-legacy
  --project <ws> [--dry-run] [--force] [--json]` copies the legacy kit's per-project state before the shadow goes off:
  checks-state.json entries of open cards into pipeline-state.json (legacy keys win, Kanban-only keys stay), runoffs.json
  by group name (decided groups too), the scoreboard without duplicate lines (legacy lines first) and qa-log.md while
  Kanban has none (the QA gate numbers rounds from it). Read-only on the legacy files, idempotent; refuses unless the
  workspace is on landing `qa` in shadow and the legacy autoland no longer owns it (`--force` plans anyway, dry run
  only). The PID-pressure reader ignores the legacy kit's flag files once review-watch is switched off (it never
  removes them). The test setup replaces a HOME outside the temp dir with a temp one, after a run without it wrote
  pipeline-worker test lines into foo's live scoreboard.
- `src/projects/project-create.ts`, `src/projects/project-roots.ts`, `src/core/project-paths.ts` (new),
  `src/projects/project-add.ts`, `src/commands/project.ts`, `src/trpc/projects-api.ts`, `src/trpc/app-router.ts`,
  `src/core/api-contract.ts`, `src/core/api-validation.ts`, `src/workspace/git-clone.ts`, `src/config/pipeline-config.ts`,
  `src/doctor/doctor-checks.ts`, `src/doctor/run-doctor.ts`, `web-ui/src/components/add-project-dialog.tsx`,
  `web-ui/src/components/add-project/*` (new), `web-ui/src/hooks/use-project-name-check.ts`,
  `web-ui/src/hooks/use-project-roots.ts`, `web-ui/src/utils/directory-picker.ts` (new),
  `web-ui/src/hooks/use-project-navigation.ts`, `web-ui/src/components/project-navigation-panel.tsx`, `web-ui/src/App.tsx`,
  `web-ui/src/components/directory-autocomplete.tsx` (removed), `docs/team/CONFIG.md`, `docs/team/RUNBOOK.md`: "New
  project" in the Add Project dialog and `kanban project create <path> [--name] [--branch main] [--no-initial-commit]`
  (one runtime procedure, tRPC `projects.create`): mkdir, `git init -b`, a README.md commit (a fallback identity for
  that commit only when git has none), then registered like `project add` (default kit, landing off). New, cloned and
  opened projects must be strictly inside a projects root (core setting `projects.roots`; `/projects` in the
  container), checked server-side with realpath (no symlink or `..` escapes); registered projects outside keep working
  and `kanban doctor` warns about them. The dialog shows the root as a read-only prefix, checks New project/Clone names
  with a debounced server typeahead (`projects.checkName`: exists/isGitRepository/isEmpty only), lists the root's
  folders one level for Open folder, and shows errors inline. "Add project" always opens the dialog (the native picker
  moved into Open folder) and is a button like "Create task". Tests get a temp `KANBAN_PROJECTS_ROOTS`.
- `deploy/Containerfile`: the image installs the GitHub CLI (`gh`) from GitHub's apt repository
  (https://cli.github.com/packages, keyring in `/etc/apt/keyrings`). No token or gh config is baked in: run
  `gh auth login` once in the container; the config lives in `/root/.config/gh` on the persistent `/root` volume.
- `src/pipeline/qa-checks-report.ts` (new), `src/pipeline/qa-gate.ts`, `src/pipeline/qa-prompt.ts`, `src/pipeline/checks.ts`,
  `src/pipeline/worker.ts`, `src/pipeline/submission-stage.ts`, `src/config/pipeline-config.ts`, `docs/team/WORKFLOW.md`,
  `docs/team/CONFIG.md`, `AGENTS.md`, tests (QA waits for the scripted checks, user's choice "D", 2026-10-07): the QA gate
  creates a dev card's QA card only once the scripted checks of its current snapshot are recorded (PASS, FAIL or ERROR),
  or after `pipeline.qa.checksWaitMin` (default 20) with "checks timed out", and appends a checks report to the QA prompt
  (per step the result, command, duration and the last 60 lines of a failed step's output; an ERROR or a timeout says
  the checks did not run). The legacy prompt text before it is unchanged. No QA slot is used while checks run; a
  workspace without checks or a snapshot without check scripts gets QA right away. A newer snapshot of the card being
  checked stops that run and drops its result. The worker evaluates the workspace again when a checks result is recorded
  and when a wait times out. Before this, QA ran without the checks and foo 27549 landed with only a checks ERROR.
- `src/terminal/agent-session-adapters.ts`, `src/prompts/cline-rules.ts` (moved from `src/setup/`), `src/setup/machine-setup.ts`,
  `src/commands/setup.ts`, `src/models/cline-providers.ts`, `src/commands/models.ts`, `src/doctor/cline-dir-checks.ts` (new),
  `src/doctor/run-doctor.ts`, `src/doctor/doctor-checks.ts`, `src/doctor/deep-checks.ts`, `docs/team/RUNBOOK.md`, `AGENTS.md`,
  tests (Kanban writes nothing under `~/.cline`, user rule 2026-10-07): Cline launches get Kanban's Cline rules as
  git-excluded worktree rules (`.cline/rules/kanban-*.md`) and `CLINE_DISABLE_CLINE_PASS_NOTICE=1` instead of
  `kanban setup` writing `~/.cline/rules` and `cli-notices.json`. `kanban setup` no longer edits Cline's providers.json:
  its `cline-providers` step checks that Cline cards can reach Bedrock (providers.json, or `AWS_BEARER_TOKEN_BEDROCK` and
  `AWS_REGION` in the environment) and prints what to run; `--force-rules` is gone. `kanban models providers --cleanup`
  lists the edits and refuses `--apply`. `kanban doctor` reports Kanban's rules left in Cline's global rules dir and the
  backups older setup runs left next to Cline's settings, with the `rm` command.
- `src/state/kanban-home.ts`, `test/runtime/state/kanban-home.test.ts`: the debug "Reset all state" no longer deletes Cline's
  data dir (`~/.cline/data`) or any other path in or around Cline's dirs (`~/.cline`, `CLINE_DIR`, `CLINE_DATA_DIR`); it
  deletes only Kanban's home and worktree roots.
- `src/server/session-summary-persister.ts`, `src/state/session-summary-merge.ts` (new), `src/state/workspace-state.ts`,
  `src/cli.ts`, `src/pipeline/restart-recovery.ts`, `AGENTS.md`, `docs/team/RUNBOOK.md`, tests (the server persists
  session summaries, 2026-10-07): the server writes every session summary change to the workspace's `sessions.json`
  itself, at most once a second per workspace, atomically under the workspace lock, without touching the board or its
  revision. Every `sessions.json` write (browser saves included) merges per task and keeps the newer summary
  (`updatedAt`, then `stateChangedAt`) and summaries only on disk, so a browser save can't roll a server summary back,
  then keeps only the summaries of cards on the board it stores (plus their detail terminals and the home-agent sidebar
  sessions), so deleted cards' summaries don't pile up.
  Shutdown writes the queued summaries and stops the persister before it stops sessions. Before this, summaries reached
  disk only with a browser save, `sessions.json` sat at `{}` for hours, and restart recovery missed card 277f8.
- `src/state/kanban-home-migrate.ts`, `src/commands/home.ts`, `docs/team/RUNBOOK.md`, tests: `kanban home migrate` also
  copies `data/` (pipeline state, decision and QA logs, scoreboard, runoffs, plans, prices, models, restart manifests)
  and `run/server-start.json`, so restart recovery on the new home matches the old server's restart manifest. For these
  files the newer one wins: a differing target file as new or newer is kept and reported as a conflict, an older one is
  replaced only after it is saved to `<home>/backups/home-migrate-<ts>/`. `--dry-run` lists every file. `.pid` files are
  skipped as transient.
- `src/plans/` (new: `plan-breakdown.ts`, `plan-index.ts`, `plan-expand.ts`, `plan-card.ts`, `plan-metrics.ts`),
  `src/kits/plan-assignment.ts`, `src/kits/plan-prompt.ts`, `src/commands/plan.ts` (new), `src/commands/task.ts`,
  `src/cli.ts`, `src/core/api-contract.ts`, `src/core/card-role.ts`, `src/kits/kit-schema.ts`, `src/kits/policy.ts`,
  `src/kits/kit-report.ts`, `kits/default.json`, `kits/team.json`, `src/server/task-landing-gate.ts`,
  `src/pipeline/restart-recovery.ts`, `src/pipeline/watchdog/stalls.ts`, `src/commands/restart.ts`,
  `src/kits/team/scoreboard/scoreboard-store.ts`, `src/state/kanban-home.ts`, `web-ui/src/types/board.ts`,
  `docs/team/WORKFLOW.md`, `docs/team/KITS.md`, `AGENTS.md`, tests (plan cards, user decision 2026-10-07: planning
  is a role of its own, like an architect next to the orchestrator's scrum master): a `plan` card role and a kit
  `plan` section (`enabled`, `agent`, `model`, `startInPlanMode`, `rules`, `candidates` for a later runoff or
  calibration, `note`). `team` plans on Claude (no model pin) in plan mode; `default` has plan off and refuses
  plan cards. `kanban task create --role plan [--plan-slug]` applies the kit's plan routing and wraps the
  requirement in the plan prompt (read the codebase; write `docs/specs/<slug>.md` with fixed sections and
  `docs/specs/<slug>.cards.json`, validated by a zod schema with dependency, cycle and parallel-group checks; one
  session per card; a STATUS line). `kanban plan show|check|approve|expand|metrics`: expand refuses unless the plan
  card is in Review and the user approved this exact breakdown (`plan approve`, or `--approved-by-user` with a
  terminal confirmation), creates Backlog cards through `createTask` (the kit's devAssignment applies) with their
  acceptance criteria in the prompt (so QA's requirements include them), links them by their dependencies, records
  plan → cards and the plan card's metrics in `data/<ws>/plans.json`, resumes a half-done expand with the same ids,
  and never starts a card; `--dry-run` writes nothing. The pipeline, QA gate, rework, recovery, restart recovery,
  auto-review, the watchdog's stall checks and the scoreboard leave plan cards alone. On landing `qa` a plan card's
  spec lands through the Done gate like dev work (only on a human's land, with no `landed` event for kit
  features). The board shows a "Plan" badge and keeps the role through browser saves.
- `src/isolation/*` (new), `src/trpc/isolation-api.ts` (new), `src/commands/isolation.ts` (new), `src/commands/message.ts`
  (new), `src/doctor/isolation-checks.ts` (new), `src/trpc/app-router.ts`, `src/trpc/runtime-api.ts`,
  `src/server/runtime-server.ts`, `src/server/watchdog-actions.ts`, `src/terminal/ws-server.ts`,
  `src/terminal/agent-guardrails.ts`, `src/terminal/agent-session-adapters.ts`, `src/terminal/cline-guard.ts`,
  `src/terminal/claude-guard.ts`, `src/guardrails/task-guardrails.ts`, `src/guardrails/command-patterns.ts`,
  `src/prompts/append-system-prompt.ts`, `src/state/workspace-state.ts`, `src/state/kanban-home.ts`,
  `src/config/pipeline-config.ts`, `src/pipeline/watchdog/watchdog.ts`, `src/pipeline/watchdog/actions.ts`,
  `src/pipeline/watchdog/headless-run.ts`, `src/server/request-caller.ts` (new), `src/terminal/session-manager.ts`,
  `src/commands/runtime-trpc-client.ts`, `src/cli.ts`, `src/doctor/run-doctor.ts`, `src/doctor/doctor-report.ts`,
  `src/doctor/guardrail-checks.ts`, `docs/fork/project-isolation.md` (new), `docs/team/CONFIG.md`, `AGENTS.md`, tests
  (project isolation, user requirement 2026-10-07): every agent session works only on its own project. Each launch
  gets a per-session credential, which the runtime API checks and only accepts from that session's process tree (the
  loopback connection traced through `/proc`; headless orchestrator runs get one bound to their pid). Cline's shared
  daemon is attributed by the calling process's `/proc` cwd, always as a card. A credential from anywhere else is an
  unknown caller, never the user. Credential-less calls are traced to a session's process tree while some workspace is
  in `enforce`. With every workspace `off` the CLI isn't scoped at all. `isolation.mode` is `off` (default), `report` (log to
  `data/<ws>/isolation.jsonl`) or `enforce`. Under `enforce`, a session's API calls, CLI board access, WebSocket
  upgrades and machine-wide operations stay inside its project. Launches deny other projects' checkouts, worktrees
  and data where the CLI can express it (Claude Code Read/Edit rules and a Bash path guard, Cline's PreToolUse guard,
  Copilot write denies; Codex and the unverified agents get a prompt note). The orchestrator gets isolation-only
  guardrails and a scoped system prompt, and wakes stay in the board's own workspace and use the sidebar session.
  Agent sessions can't create, register or remove projects in any mode. The user's escape hatch is `kanban isolation
  grant` (in-memory, user-only, logged on both sides), completed with a one-time code printed only on the server's
  console (`kanban isolation approve`). Under `enforce` the user's own project changes need one too, except from a
  passcode-authenticated browser. Claude Code and Cline also refuse shell writes to the machine-wide config, and
  every isolation mode change is logged. `kanban message send|inbox|reply` adds orchestrator-to-
  orchestrator requests, addressed by project, with an authenticated sender and a per-project
  `workspaces.<id>.isolation.messages` switch (default `deny`). The receiver gets only a fixed notice, queued until its
  Review has settled with nothing typed, rate-limited per pair, and messages are logged on both sides. `hooks.ingest`
  is checked by ownership, with no process lookup. Before rolling back, remove the `isolation` keys from config.json. `kanban doctor` shows each workspace's isolation per agent (native / partial / prompt-only).
- `src/setup/cline-lemonade-apply.ts`, `src/commands/cline.ts` (new), `src/setup/cline-lemonade-models.ts`,
  `src/setup/cline-models-source.ts`, `src/setup/machine-setup.ts`, `src/doctor/cline-models-checks.ts`,
  `src/doctor/run-doctor.ts`, `src/models/lemonade-models.ts`, `src/isolation/cli-scope.ts`, `src/cli.ts`, `AGENTS.md`,
  `docs/team/RUNBOOK.md`, tests (Kanban prints the Lemonade edits for Cline's models.json and the user applies them,
  user's choice "C", 2026-10-07): `kanban setup` no longer writes Cline's `models.json`. Its `cline-models-source` and
  `cline-lemonade-models` steps compare the Lemonade provider entry (the `modelsSourceUrl` pointing at Kanban's
  model-lists route; each listed model's contextWindow, maxTokens, supportsVision, supportsReasoning and zero prices) with
  what it should be and, when they differ, list every change and print `kanban cline apply-lemonade-models --origin
  <origin>` (status "to do by hand"). That command is the only Kanban code that writes the file, and only when the user
  runs it (agent sessions are refused it in every isolation mode): it copies models.json to
  `<home>/backups/cline/models.json.<UTC>` (0600, never next to Cline's files), replaces the file atomically with its mode,
  changes only `providers.lemonade` and writes nothing when the file changed meanwhile; `--dry-run` prints only. Models
  Lemonade no longer lists are now dropped from the entry (before, they were kept). `kanban doctor`'s Lemonade row now
  compares models.json with what Lemonade reports (one round of requests, 1.5 s timeout): WARN with the added, removed
  and changed models and the command, PASS in sync, INFO when Lemonade is down.
- `src/trpc/plans-api.ts` (new), `src/plans/plan-target.ts` (new), `src/commands/plan.ts`, `src/plans/plan-expand.ts`,
  `src/trpc/app-router.ts`, `src/server/runtime-server.ts`, `src/isolation/approvals.ts`, `src/isolation/cli-scope.ts`,
  `src/trpc/isolation-api.ts`, `web-ui/src/components/plan-approval-button.tsx` (new),
  `web-ui/src/hooks/use-plan-approval.ts` (new), `web-ui/src/stores/current-workspace-store.ts` (new),
  `web-ui/src/components/board-card.tsx`, `web-ui/src/App.tsx`, `docs/team/WORKFLOW.md`, `AGENTS.md`, tests (plan
  approval is the user's, user decision 2026-10-07): `kanban plan approve` and `kanban plan expand --approved-by-user`
  ask the running server (`plans.preview`/`plans.approve`) instead of writing the plan index in-process. In every
  isolation mode the server refuses agent sessions (credential, process tree or unidentified) and holds anyone else's
  approval until the one-time code it prints on its console is entered (the CLI's terminal prompt, `kanban isolation
  approve`, or the board's dialog); a passcode-authenticated browser needs none. The approval stays pinned to the
  breakdown's sha256, now the one the user was shown. The CLI refuses both commands inside a session. A plan card in
  Review gets an Approve plan button with a confirmation dialog (spec title, card count, code field). The console
  line now reads "Approval <id> (<kind>)" for every kind.
- `src/projects/project-rename-id.ts` (new), `src/commands/project.ts`, `src/state/kanban-home.ts`,
  `src/state/kanban-home-migrate.ts`, `src/isolation/cli-scope.ts`, `docs/team/RUNBOOK.md`, `docs/fork/project-isolation.md`,
  `AGENTS.md`, tests (user request 2026-10-07): `kanban project rename-id <old> <new> [--move-aside] [--dry-run]`
  changes a project's workspace id. A user action refused from every agent session; it refuses while a Kanban server
  runs on the home (the same check as `home migrate`, now shared). It backs up to `<home>/backups/rename-id-<ts>.tgz`,
  then moves every path named after the id (`getWorkspaceIdKeyedPaths`) and rewrites the stored references (index,
  config.json `workspaces.<id>` and `orchestrator.wake.target`, home-agent session ids, `messages.jsonl`, calibration
  specs, restart-recover requests). Logs keep the old id as history. State left at the new id by an unregistered
  project is refused unless `--move-aside`. A journal in `run/rename-id.json` makes a rerun finish an interrupted run.
- `src/terminal/cline-card-dir.ts`, `src/terminal/cline-hook-identity.ts` (new), `src/terminal/agent-session-adapters.ts`,
  `src/terminal/cline-guard.ts`, `src/commands/hooks.ts`, `AGENTS.md`, tests (foo 4189a, 2026-10-07: its writes were
  blocked as "outside this card's worktree" of whichever foo Cline card started last). A project that git-ignores
  `.cline/` got it mirrored into every task worktree as a symlink to the main checkout's `.cline`, so all its Cline
  cards (and its Cline sidebar session) shared one `.cline/hooks`, and each launch rewrote everyone's hook scripts with
  its own `--task-id` and guard policy. cline 3.0.69 runs each session's hooks from that session's workspace (the
  hub daemon only supplies the env), so the files themselves were wrong. Now a Cline launch first makes `.cline` the
  card's own directory: a Kanban-mirrored symlink becomes a real directory whose other entries link to the shared ones,
  and whose `hooks` and `rules` link only the user's own files (Kanban's hook scripts and the orchestrator's rule stay
  per session). A `.cline` or `.cline/hooks` symlink Kanban didn't make fails the launch with an error. Every Kanban
  Cline hook also checks the payload's `workspaceRoots[0]` (the session's worktree, sent by cline 3.0.69 with every
  hook event): `kanban hooks cline-guard` against its policy's worktree, `kanban hooks notify|ingest` against the new
  `--workspace-root` flag the scripts pass with `--task-id/--workspace-id`. A call from another worktree's session,
  a payload without a root, a `cline-cli` notify without `--workspace-root` (scripts written before this change), or
  `--workspace-root` without the card's ids is refused (the guard cancels the tool with the reason). A Cline launch
  without a workspace id writes no notify step at all, because that would report for the daemon env's card. Cards
  running on old scripts get their own hooks at their next launch or `kanban task resume`.
- `src/terminal/cline-turn-check.ts`, `src/terminal/cline-session-files.ts`, `src/pipeline/recovery.ts`,
  `src/pipeline/recovery-prompts.ts`, `src/pipeline/recovery-runtime.ts`, `src/pipeline/watchdog/watchdog.ts`,
  `src/config/pipeline-config.ts`, `src/config/cline-turn-detector-config.ts`, `src/server/process-reaper.ts`,
  `src/terminal/agent-session-adapters.ts` (exports `CLINE_CLI_ASK_TOOL_PATTERN`), `AGENTS.md`, `docs/team/CONFIG.md`,
  tests (silent stalls of Cline cards, foo
  2026-10-07 22:15Z): four Cline cards sat "running" for 15 min on a tool_use with no result while their TUIs repainted.
  The cause, a `.cline/hooks` shared through the mirrored `.cline` symlink, is fixed by `ensureCardOwnedClineDir()`
  (entry above). As a safety net, recovery (mode `on`) now nudges a running Cline card whose session file shows no
  progress for the new `pipeline.recovery.stallNudgeMin` (default 8). An interrupted step gets a "your last tool call
  didn't return" note; anything else gets the usual continue. The nudge budget and escalation are those of crash
  nudges, and the decision cause is `silent_stall`. Each further nudge needs another `stallNudgeMin` of silence, a
  hook counts as progress, a pending ask tool is no stall, and a `run_commands` call whose command still runs (a
  descendant of the agent or a Cline hub daemon working in the card's worktree) is never nudged. The watchdog only reports these stalls. Restart resumes are not
  staggered further: the cards stalled on a guard cancel, not on start-up contention (`resumeGapSec` stays 20).
  Recovery, the watchdog and the Cline turn detector now resolve `agents.cline.dataDir` the same way, as the Cline CLI
  does (`~` expanded, `CLINE_DATA_DIR`, `CLINE_DIR/data`).
- `src/issues/` (new: `issue-provider.ts`, `github-provider.ts`, `issue-auth.ts`, `issue-repo.ts`, `issue-trust.ts`,
  `issue-prompt.ts`, `issue-state.ts`, `issue-sync-plan.ts`, `issue-apply.ts`, `issue-sync.ts`, `issue-job.ts`,
  `issue-comment.ts`), `src/commands/issues.ts` (new), `src/doctor/issue-checks.ts` (new), `src/config/pipeline-config.ts`,
  `src/core/api-contract.ts`, `src/core/task-board-mutations.ts`, `src/pipeline/actions.ts`, `src/pipeline/worker-protocol.ts`,
  `src/pipeline/worker-host.ts`, `src/pipeline/worker.ts`, `src/pipeline/watchdog/watchdog.ts`, `src/pipeline/decision-log.ts`,
  `src/server/pipeline-actions.ts`, `src/server/runtime-server.ts`, `src/server/task-landing-gate.ts`, `src/workspace/land.ts`,
  `src/kits/dev-assignment.ts`, `src/state/kanban-home.ts`, `src/doctor/run-doctor.ts`, `src/doctor/doctor-report.ts`,
  `src/cli.ts`, `web-ui/src/types/board.ts`, `web-ui/src/state/board-state.ts`, `AGENTS.md`, `docs/team/CONFIG.md`,
  `docs/team/WORKFLOW.md`, tests (user request 2026-10-07): issue import. A project pulls issues from its own remote
  repository (GitHub first, `workspaces.<id>.issues`, mode `off`/`report`/`on`, default off) into Backlog cards
  titled `#N <title>` with an `issue` card field (deduped across all columns and after prune-done). Strict trust
  filter by default (OWNER/MEMBER/COLLABORATOR authors or the `kanban` label), the issue text fenced and quoted as
  untrusted in the prompt, the kit's devAssignment (or plan routing for the `needs-plan` label) on creation, never
  started; Backlog cards get "Update" sections and a closed-upstream marker, started cards' updates go to the
  orchestrator's next wake. The worker's sync job (a watchdog core job) writes the board through the new
  `applyIssues` request; `kanban issues sync|list`; conditional requests and rate-limit backoff; auth from `gh`, the
  env or anonymous, never written anywhere. Kanban's landing commit adds `Fixes #N` for dev cards; optional
  `issues.commentOnLand`. A doctor row per project.
- `src/issues/*`, `src/pipeline/rework.ts`, `src/pipeline/actions.ts`, `src/server/pipeline-actions.ts`,
  `src/isolation/cli-scope.ts`, `src/doctor/issue-checks.ts`, docs, tests (review of the issue import, 2026-10-08):
  comments by untrusted users never reach a prompt (a count line instead), an untrusted author's edits are only
  noted and a removed trust label stops updates; card titles are `Issue #N: <sanitised short title>` for trusted
  authors and `Issue #N` otherwise; the apply step plans under the issues-state lock (no double Update); an
  unparsable issues-state.json is backed up and never overwritten; the repository is pinned on the first sync
  (origin changes are refused until `issues.repo` is set); next-page links are cached for 304s and refused off the
  API origin; report mode fetches comments only for changed issues; rework siblings keep the `issue`; card
  sessions can't run `kanban issues sync`.
- `src/terminal/session-manager.ts`, `src/server/workspace-registry.ts`, `src/cli.ts`, `src/pipeline/qa-gate.ts`,
  `src/pipeline/recovery-stage.ts`, `src/pipeline/engine.ts`, `src/pipeline/worker.ts`, `AGENTS.md`, tests: QA cards
  and stale sessions survive an unexpected restart (foo, 2026-10-07 23:02:56Z). When the server loads a workspace's
  session summaries (only once it has bound the port, and only with session sync on), every `running` summary with
  no process is marked `interrupted` with a newer `updatedAt` and persisted. Restart recovery treats `interrupted` like
  `running`, including the Cline turn-end check. With session sync on, the project list no longer counts interrupted
  cards as Done. With restart recovery not acting (`pipeline.recovery.mode: "report"`), a Review dev card whose session
  the restart cut off is not snapshotted or QA'd. The QA gate decides liveness itself: one of its QA cards that went
  to Done without an ingested verdict, left the board, or whose session started before this server and has no process
  is retired, both when its dev card is submitted and on every tick, so it no longer blocks a new QA card or holds a
  QA slot. A verdict.json the card had already written is recorded as usual; otherwise the card is superseded and its
  dev card gets a new QA card for the same snapshot. A superseded card is never ingested. Restart recovery's
  `recreate_qa` hands the gate's orphaned QA cards over with an orphan mark (`kind: "qa"`) and never resumes them.
  For an existing QA card the gate's note now reads "snapshot X already has QA card Y (... created <time>, <status>);
  no new QA card" instead of "was created". On the first tick after this deploys, the gate retires every stale
  `running`/`queued` entry at once (foo's a5e91 and 257a4 among them), logged as one summary line per workspace
  (`qa_start`, no task) plus one line per card, so dev cards still in Review get new QA cards in one burst.
- `.github/workflows/test.yml` (called by `ci.yml` and `publish.yml`): CI and release testing are Linux-only (ubuntu
  on Node 20 and 22); the macOS leg and its Python pin are removed, so macOS installs of `@vombor/kanban` are untested.
- `.github/workflows/publish.yml`: a tag push no longer fails at "Resolve tag": `actions/checkout` has already made
  the pushed tag a lightweight ref, so the tag fetch runs with `--force` to replace it with the annotated tag (a plain
  fetch refused it as "would clobber existing tag"). The compare link picks the previous fork tag (`v*-fork.*`) and
  falls back to the nearest tag only when there is none.
- `src/setup/cline-bedrock-key.ts`, `src/setup/cline-file-write.ts`, `src/setup/cline-lemonade-apply.ts`,
  `src/setup/machine-setup.ts`, `src/doctor/cline-bedrock-key-checks.ts`, `src/doctor/run-doctor.ts`,
  `src/commands/cline.ts`, `src/isolation/cli-scope.ts`, `docs/fork/cline-bedrock-auth.md`, `docs/fork/github-auth.md`,
  tests: Cline's Bedrock key comes from the environment (`AWS_BEARER_TOKEN_BEDROCK`, the podman secret
  `Secret=<name>,type=env,target=AWS_BEARER_TOKEN_BEDROCK`), not from Cline's providers.json. cline 3.0.69 falls back
  to the env key only while providers.json stores none. This was verified with real runs, both direct and in its hub
  daemon. `kanban doctor` has a row that warns when providers.json stores a key the environment already provides. It
  also says so when the env var is missing but Bedrock is in use, and flags a running Kanban server or Cline hub
  daemon that doesn't have the same value. It never prints a key, only whether one is stored and whether it equals the
  env's. `kanban setup`'s `cline-providers` step recommends the env var in the same words. The new user-only command
  `kanban cline remove-bedrock-key [--dry-run]` deletes only `providers.bedrock.settings.apiKey`. It refuses without
  the env var, while the server or a hub daemon lacks the same value, or when stored access keys would take over.
  Agent sessions are refused it too. It backs up to `<home>/backups/cline/` first, writes atomically and prints the
  rollback line. The backup and atomic-write helpers moved out of `cline-lemonade-apply.ts` into `cline-file-write.ts`.
