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
