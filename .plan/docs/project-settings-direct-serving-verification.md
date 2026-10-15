# Project settings / direct serving verification handoff

Updated 2026-10-14. Reconstructed from the existing uncommitted changes after the prior conversation/task list was
unavailable. This is an inferred work list, not a recovered original plan.

## Workstreams

- [x] Consolidate display name, script shortcuts and secrets in Edit Project; keep Global Settings installation-wide.
- [x] Order Add Project tabs New / Clone / Open; give New project a details step and optional secrets step.
- [x] Preserve successful partial saves and retry secrets without creating another project.
- [x] Add a locally auto-unlocked AES-256-GCM project vault with metadata-only APIs and user-only writes.
- [x] Rebind authenticated encryption on workspace-id rename; exclude request bodies from server error telemetry.
- [x] Remove HTTP/state/terminal WebSocket Host and Origin whitelists; retain shortcut-preview sandboxing.
- [x] Bind the image to 0.0.0.0 without a pinned port; use the CLI default or installation runtime-port override.
- [x] Move browser tests to isolated contexts on the existing shared Chrome sidecar via CDP.
- [x] Persist machine-wide QA provider quota holds and import existing recorded deadlines.
- [x] Forward QA score/visual reports to the scoreboard; repair exact missing score vectors append-only.
- [x] Report fresh-attempt submission timing/tool counts separately from historical cumulative metrics.

## Verification completed

- `npm run check`: passed; runtime/web-ui typechecks and 2,835 runtime tests across 320 files.
- `npm run web:test`: passed; 705 tests across 100 files.
- Shared-Chrome mobile config: all 29 tests passed. After the edge-case fixes, all four affected direct-serving and
  phone/desktop project-settings tests passed again.
- Shared-Chrome desktop config: all four smoke tests passed.
- Production build: passed in a temporary copy of tracked and untracked source, using the checkout's installed
  dependencies. Sentry upload was disabled. The working checkout's build outputs were not replaced.
- Built the actual revised Containerfile from its npm tarball, with pinned agent CLI versions, under a local-only
  verification tag. Ran `scripts/container-smoke.mjs` with no network, host mounts, credentials or published ports:
  non-root user, global CLIs, native PTY, project npm install, empty initial registry, explicit setup, first-project
  creation without privileges, home/port overrides and graceful lifecycle shutdown all passed.
- Changed TypeScript/TSX files were checked/formatted with Biome; `git diff --check` passed.

## Fixes discovered during verification

1. **Missing vault key across projects:** the original code could create a replacement installation key when saving
   a new project's first secret, even though another project retained ciphertext. Key creation now checks the home's
   existing project vaults while holding the key lock, refuses existing encrypted records or unreadable/damaged
   vaults, and permits genuinely empty vaults. Regression tests cover refusal and recovery with the original key.
2. **Remote `--no-passcode`:** Commander exposes the negated flag as `passcode: false`, but the root launch read
   `noPasscode`. Corrected the mapping in `src/cli.ts`; the browser regression now binds to 0.0.0.0 so localhost-only
   launches cannot hide this bug. The image smoke passed after the fix.
3. **Smoke diagnostics/cleanup:** report unexpected project-list responses explicitly and launch the disposable
   runtime in its own process group, cleaning that group on failure/timeout rather than leaving its child server
   alive until the outer smoke timeout.
4. Cleaned two scoreboard template-literal notices and stale development-origin documentation/comments.

## Remaining boundaries

- One pre-existing unused-import lint warning remains in `test/runtime/pipeline/rework-limits.test.ts`; it does not
  fail checks and was not changed.
- The vault stores values only. No plaintext-get API, agent environment injection, script binding, database
  provisioning or other runtime consumer was enabled. Its local auto-unlock key is not protection against shell
  code running as the same Unix user. See `docs/fork/project-secrets.md`.
- No commit, push, publish, deployment, live restart or live configuration change was performed. Browser tests
  touched only their own contexts and throwaway instances; container validation used a separate disposable image.
- The unrelated `.vscode/settings.json` edit and all pre-existing work were preserved.

## 2026-10-15 dual-stack follow-up

The no-deployment statement above describes the original verification pass. The user subsequently approved a local
deployment and then the IPv6 localhost fix. Installation backups, image selection and rollback details are recorded
with the installation, not in product code or its npm payload.

- Rootless Podman's wildcard publication accepted IPv6 localhost, but an IPv4-only application listener reset it.
  Explicitly publishing on 0.0.0.0 reproduced the reset in a disposable container; that was not a sufficient fix.
- The approved image CMD now binds `--host ::` (Linux dual-stack), still with no pinned port. Shared endpoint URL
  builders bracket IPv6 literals for HTTP/HTTPS/WS/WSS, preserving the raw listener/environment address.
- Added four IPv6 endpoint regression cases, expanded direct-serving browser tests to IPv6 and localhost, and made
  the disposable image smoke check HTTP/state sockets through all three loopback names plus CLI/lifecycle operation
  with an IPv6 runtime host. The rootless gotcha and pod-level PublishPort ownership are recorded in AGENTS.md and
  docs/fork/direct-serving.md.
- `npm run check`: passed with 2,839 runtime tests and both typechecks. The same pre-existing lint warning remains.
- Shared-Chrome direct-serving tests: all three passed, including terminal/state sockets from IPv6 browser pages.
- Production build and revised Containerfile smoke: passed. A separate disposable run of the actual image CMD with
  a host-published ephemeral port returned HTTP 200 via localhost, 127.0.0.1 and [::1].
- After the user's approved Kanban-only restart, host-side localhost connected to ::1 and returned HTTP 200. HTTP
  and state WebSocket checks passed through all three loopbacks with an unrelated Origin; all four projects loaded.
  The pod, Chrome and Postgres service start times were unchanged.
- The live instance uses a local-image override until the changes are published; its inherited registry auto-update
  label is explicitly cleared, not just the Quadlet AutoUpdate setting. No commit, push or publish was performed.

## Publication preparation

The user approved committing, publishing and returning the installation to its registry channel after verified
publication. The source work is separated into project editing/vault, networking/shared-Chrome, durable quota-hold,
and scoreboard commits. The unrelated editor setting stays uncommitted. GitHub access must use the installed Kanban
App (Contents/Actions/Workflows write were verified), with credentials kept out of arguments, logs and saved state.
The local-image override stays in place until the pushed head's image workflow and registry revision are verified.
