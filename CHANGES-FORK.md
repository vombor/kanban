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
