# GitHub issue triage and fixes — 2026-10-16

## Autonomous completion/release authorization

The user subsequently authorized resolving/closing all issues autonomously and publishing a new Kanban version with
release notes. Existing edits remain owned by this session. Do not upgrade the live instance merely because a release
is published. No historical benchmark rerun, model substitution or fabricated acceptance is authorized.

Release continuation checklist:
- [x] Implement/test the original #58/#59/#62 fixes and initial #61/#63 improvements.
- [x] Add scoped supported acknowledgement/defer, terminal-STALLED and evidence-only review controls.
- [x] Package pinned shared-Chrome tooling and actual PNG decoding/readiness verification.
- [x] Harden/validate the new controls, including restart, authorization, exact-snapshot and no-auto-action behavior.
- [x] Implement #53 persistent provider-wide start/input scheduling, user settings and own-project restrictive pacing.
- [x] Recheck all issue comments/current open issues and prepare evidence-backed dispositions.
- [x] Publish issue resolution/closure receipts through the GitHub App after verified release publication.
- [x] Run full local checks, shared-Chrome journeys, exact-tag production/package validation and secret scans.
- [x] Commit fixes with closing references, increment the fork release, write release notes, tag and push via the App.
- [x] Verify the exact .11 tag's validated non-root image publication and matching stable/versioned image metadata.
- [x] Verify the exact .11 tag's CI npm package publication.
- [x] Verify successful package/release/image publication, close resolved/duplicate issues, and reconcile this checklist.

All 19 open vombor/kanban issues and all returned comments were read through the Kanban GitHub App. No live project,
benchmark, provider, credential, price table or pipeline configuration was modified, and no issue was closed.

## This implementation batch

- #62: reproduced the retained row's absent `cacheWrite`. Accept cache omissions conservatively at input price,
  preserve explicit zeros/manual/pinned rates, diagnose fields before network access, and refuse malformed JSON.
- #58: validate typed flows before browser startup, honor requested script viewports, scope text assertions, retain
  numeric dimensions and distinct images, and replace stale reports on failed reruns. No toolchain provisioning change.
- #59: retain a completed bench-only PASS hold when an earlier sequential contender was archived, accurately describe
  that result, and keep the explicit preserve/discard exit. No automatic benchmark landing or historical rewrite.
- #63 (partial): reconcile an explicitly started queued native reviewer while paused; allow same-card explicit dead
  Review triage continuation without falsely requiring dev handback or mutating dev flow. Terminal STALLED/cancel
  replacement controls and durable restart artifact preservation remain outstanding.
- #61 (partial): append authoritative, executable, shell-quoted sequential setup guidance while preserving the legacy
  skeleton; isolate scratch copies per workspace/reviewer and treat database notes as prose with fail-closed isolation.
  Safe unchanged-snapshot re-review of closed benchmark runs remains outstanding. Finished runs are not reopened.

The partial descriptions above record the initial batch boundary; the autonomous additions below complete those
controls. No finished benchmark is reopened, and evidence-only reassessment remains separately authorized.

At this initial batch boundary, implementation and validation were finished but uncommitted and undeployed; the
lifecycle/scheduling/toolchain follow-ups were not yet complete. The autonomous additions and final receipts below
record their subsequent implementation and publication. The live instance remains deliberately unupgraded.

Validation:

- `npm run check`: formatting/lint (only the pre-existing rework-limits unused import warning), both typechecks,
  all 2,891 runtime tests passed. All 714 web-ui unit tests passed.
- Production build passed in an isolated source export with sourcemap upload disabled.
- Real shared-Chrome normal-input journeys produced distinct 375x667 and 1280x720 PNGs for a flow array, and an
  800x600 PNG for a pinned envelope. Parsed PNG headers and report dimensions agreed. Proof lives outside the repo
  at `/tmp/opencode/issue58-browser-proof-1aFef2/proof.json`; only owned contexts and a throwaway app were used.
- The actual retained 28-row live price table validates against the new schema when read-only copied into the
  local parser; no live price sync/cache/apply or table write was performed.
- Generated Bash extraction examples executed successfully against a throwaway Git repo, including apostrophes/
  spaces in paths; a second attempt refused to overwrite the retained evidence.

## Existing implementation or overlap — no new closure claimed

Source/tests already contain corresponding paths for #41 (checks evidence), #42 (own-project landing settings),
#45 (optional preset rebase; no model allow-list), #46 (cherry-picked Done), #48 (browser guidance/doctor), #49
(persistent quota holds, including legacy import), #50 (explicit preserve tag), #51/#56 (compact/hidden notices),
#52 (Codex bracketed paste/delivery proof) and #55 (score backfill and reset-scoped metrics). Open status alone is not
evidence these need another code patch; these were not silently closed or treated as approval to alter live settings.

## Autonomous completion additions

- #53: private durable provider-start intents; serialized reservation across registered projects, separate cloud QA
  slots and quota holds, typed-input admission/holding, user caps in the single-Save popup, strict own-project pacing,
  current scoped status and card badges. Queue validity is checked before launch and badges are broker-owned.
  Shared-Chrome end-to-end proof exercises actual Kanban starts, persistent restart reconciliation and cancellation.
- #57: exact packaged `playwright-core`/`pngjs` dependencies external to esbuild; native shots connect only to shared
  CDP. Readiness drives normal input and verifies actual decoded RGBA pixels at mobile/desktop sizes. No per-card
  installs, browser launch/download or use of agents' tabs. Doctor/injected instructions name the supported proof.
- #60: durable `pipeline acknowledge` records held/deferred reasons, expiry and own-project prerequisites with
  evidence fingerprints. Watchdog separates acknowledged holds from human decisions, suppresses unchanged wakes,
  reawakens on changed prerequisite verdicts, and removes Done-card notices. It never clears escalation/forges fixed.
- #61/#63: strict own-project/manual controls for audited terminal STALLED and one exact-snapshot evidence-only
  reassessment. Normal recovery/landing/rework are held; evidence-only findings remain separate from normal verdicts,
  scoring and runoff decisions, with no replacement loop. Restart retirement preserves available partial artifacts.
  Done experiments are refused, not reopened. Cross-project, card and unknown callers are rejected.
- #51/#56: Global Settings exposes Compact/Tiny/Full notice presentation, with Compact the new default; explicit
  saved choices and per-project overrides remain authoritative. Full diagnostics still commit before the pointer.

## Release authentication blocker

Prepared next version was `0.1.70-fork.10`, with user-facing `CHANGELOG.md` notes covering all unreleased changes since .9.
The user approved the registry-only exception on continuation (2026-10-17): CI npm/GHCR writes use the automatically
generated Actions `GITHUB_TOKEN` with `packages: write`. No token is added to the pod, and no PAT fallback is allowed.
Commits/tags, issue updates, workflow dispatch and GitHub release creation still use the Kanban App. The host creates
the GitHub release with notes after verified package and versioned/stable image publications. Workflows are updated;
package Actions access can still require a user permission grant if GitHub refuses the generated token.

Final local validation (2026-10-17): 2,915 runtime tests, 718 UI tests and both typechecks passed; three clean
shared-Chrome browser cases passed (connector phone/desktop, real persistent-provider queue/restart/cancel/main-Save).
Readiness decoded actual RGBA pixels at both sizes. Production build/pack passed in an isolated export; an exact
committed export, secret scan and CI's bare-image/publication proof are the remaining gates. The final browser pass
also caught/fixed cap-draft resets on config refetch and unrelated connector-loading blocks on provider-only Save.
Historical setup attempts, verdicts and live provider/benchmark configuration are unchanged.

## Issue closure evidence to publish with the release

### Failed .10 publication / continuation (2026-10-17)

`d67988c6da1e6e09907dc8e221bfe52c92e59d27` and immutable tag `v0.1.70-fork.10` were pushed as the Kanban App.
Package run `38986998915` failed lint because the final e2e diagnostic listener was not reformatted after the local
check; that formatting-only correction is now applied. Image run `38986998845` passed build/tests and bare non-root
smoke, then upload failed with `denied: permission_denied: write_package`. The user must grant `vombor/kanban` Write
access in the existing container package's Manage Actions access (and npm package access should be checked) before
publication can proceed. Do not use the PAT, rewrite the .10 tag, mark issues closed, or claim a release was published.
The corrected pending release is `.11` with the same user-facing notes and a clear `.10` not-released entry.
Private CI receipts/scripts: `/var/home/keith/.local/state/kanban-maintenance/fork10-release-20261017-7t3xe6ii/`.
Those scripts pin .10/its commit and must not be reused unmodified for .11. No live update happened.

User correction: the exact `vombor/kanban` repository already has Admin Actions access to both packages and inherited
access is enabled. Failed image job logs confirm effective `Packages: write` and successful Docker login. Therefore
do not keep asserting a missing repository grant: the failure is at GHCR push authorization despite those grants.
Added safe early exact pull/push scope preflight and aligned the login username with the workflow actor; generated
registry credentials and response tokens are never printed. The updated branch can diagnose before rebuilding.

Follow-up preflight `38991072822` on `2a2bc96c` confirmed that workflow and existing package resolve to the SAME
repository id `1406894052` (container package id `15817368`). Token exchange and package metadata read work; the
actual POST starting an empty upload fails HTTP 403, before any image/tag publication. This is not merely a failed
upload-cancellation permission. No visible workflow/repository-grant fix remains identified; do not weaken auth,
delete/recreate packages, change inheritance or fall back to PAT. Asked the user to start image.yml via GitHub UI's
Run workflow on fork/stack as a diagnostic of human-triggered vs App-triggered authorization (not a guaranteed fix).
Current branch is clean/pushed through the App, latest head `2a2bc96c`; .11 tag remains uncreated. Final local checks
on the corrected candidate: 2,916 runtime tests, 718 UI tests, both typechecks. Private .11 ledger:
`/var/home/keith/.local/state/kanban-maintenance/fork11-release-20261017-v8nrrwvj/`.

User follow-up resolves the package-settings ambiguity: the earlier Admin/inheritance check was for npm, not the
container package. The user has now corrected the container package and authorized a retry. Run `38991072822`
attempt 2 no longer returns HTTP 403; it reaches a bad assumption in our new preflight, which accepted only the
Distribution API's plural `blobs/uploads/` location. GHCR returns singular `blobs/upload/`. Accept either location
only on exact HTTPS ghcr.io and the intended repository, preserving query parameters privately; regressions cover
both forms plus cross-host/protocol/repository/fragment refusals. No further package access change is requested.
Release publication and issue closure remain pending; no live instance update is authorized.

Corrected-location run `38991797298` definitively confirms `uploadAuthorized: true` with the generated token. GHCR's
temporary upload DELETE returns HTTP 405 (not implemented), so the preflight now records uncancelled/unsupported
cleanup honestly and permits publication only for that specific cleanup response; no bytes/blob/manifest were sent.
403 and unsafe upload locations remain failures. The container-package grant is fixed; no PAT or human trigger is
needed. Final local checks repeated on `2b66e08c`: 2,916 runtime tests, 718 UI tests, both typechecks, secret scan clean.

Immutable `.11` tag now points to `93b33c8a3ea0ba78c00eff4adca546c307ce839a`, pushed atomically with fork/stack as
the Kanban App. The new .11-only watcher is awaiting both tag-triggered registry workflows; it does not create the
release or close issues. Exact-tag production build and pack succeeded in `/tmp/opencode/fork11-exact-release-b5c8ku_2`.
Secret scan from .9 through the release candidate: 15 commits, clean. All 19 issues/comments were rechecked and are
unchanged from the reviewed snapshot, with no new open issues. User-requested workflow display-name change to
lowercase `publish` was committed/pushed separately as `72de61b2`; the existing .11 tag was not rewritten.

OpenCode side question: global auto-compaction uses `/var/home/keith/.config/opencode/opencode.json`, currently no
override. Live V2 model API reports identical context/input/output limits for Global Sol 6.1 and Ultrafast:
1,050,000 / 922,000 / 128,000. This rules out a configured window difference, not a backend/conversation failure.
No compaction/model setting or service state was changed. The actual Desktop V2 CLI is
`/var/home/keith/.config/ai.opencode.desktop/cli/2.0.30-x64/opencode-cli`; ~/.local/bin/opencode is a Flatpak GUI launcher,
not the CLI. Read-only CLI API requests use normal service discovery/authentication, never direct unauthenticated HTTP.

`.11` image workflow `38991969317` passed every gate, including the registry preflight, full build/tests, bare non-root
smoke and upload. Anonymous readback verifies BOTH `:0.1.70-fork.11` and `:stable` carry revision
`93b33c8a3ea0ba78c00eff4adca546c307ce839a`, release version `0.1.70-fork.11`, and the SAME digest
`sha256:b852555ef221d4295f518d9bd516b9d71506e9bea0b7d51820baf5d25400c3e1`.
The publication watcher lost one API read after image success; a fresh App-authenticated direct read confirms npm
run `38991969287` has passed Node 22/24 tests and is still publishing. A read-only watcher was resumed, with bounded
API retries only; publication was NOT rerun. Release creation and issue closures remain gated on npm success.
Live readback still reports package .9 and revision `8827128fb652d3e1d9ced550cb0cba305e5be2a7` on HOME=/home/node;
the running instance was not upgraded.

## Final verified publication and issue closure — 2026-10-17

All release checklist items are complete. The immutable `.11` release commit is
`93b33c8a3ea0ba78c00eff4adca546c307ce839a`; `.10` remains unchanged and unreleased.

- npm publication succeeded in run [38991969287](https://github.com/vombor/kanban/actions/runs/38991969287), including
  both Node 22/24 test jobs. Publish logs confirm `+ @vombor/kanban@0.1.70-fork.11`, with npm dist-tag `next`.
  Independent App-authenticated package metadata confirms version id `1400226123`:
  https://github.com/users/vombor/packages/npm/kanban/1400226123
- Versioned/stable image publication and non-root smoke succeeded in run
  [38991969317](https://github.com/vombor/kanban/actions/runs/38991969317). Fresh registry readback after both jobs
  confirms the exact release revision/version and equal digest recorded above for both image tags.
- The Kanban App published the changelog notes as a prerelease, with a compare link from the last successful .9 release:
  https://github.com/vombor/kanban/releases/tag/v0.1.70-fork.11
- All 19 issues were re-read with every comment before closure and checked for new edits before mutation. Each now
  has an issue-specific App-authored resolution/evidence comment and verified CLOSED state:
  #41, #42, #45, #46, #48, #49, #50, #51, #52, #53, #55, #56, #57, #58, #59, #60, #61, #62, #63.
  Final open issue count: **0**. Private comment URLs, release author/id and artifact receipts are in the .11 ledger.
- No historical benchmark was rerun/reopened, model substituted/promoted or verdict fabricated. The live instance
  still runs revision `8827128fb652d3e1d9ced550cb0cba305e5be2a7`, package .9, as node. Publishing does not authorize
  upgrading it. The later `publish` workflow casing-only commit is separate from the immutable release.

The GitHub auth interruption affected only a read-only watcher; it did not cause a second publication. The release
used generated Actions credentials solely for registry uploads and the Kanban App for all repository/release/issues.

OpenCode chat diagnosis in parallel: the service log for session `ses_ec4ad8455ffesaLPP5J1w0yu5l` reports intermittent
`AI.Error.InvalidRequest: this conversation cannot be continued` (including 2026-10-17T00:36:41Z and 01:16:00Z).
The log does not expose a more specific model/provider cause; do not call it an authentication/quota/context-limit
failure without evidence. No OpenCode settings, service or conversation data were reset.

| Issue | Resolution/disposition |
|---|---|
| #41 | Existing .8 checks-evidence guard and `qa-checks-verdict` regressions prevent unanswered/contradicted PASS landing. |
| #42 | Existing .8 strict own-orchestrator `kit apply --landing` and attributed history, with cross-project/card refusals. |
| #45 | Existing .8 optional preset rebase/selected pins/dry-run and informational doctor notice; model choices remain project-owned. |
| #46 | Existing .8 cherry-picked snapshot accounting; tests still protect WIP/new commits/unique merges. |
| #48 | Explicit browser fallback/doctor plus this release's pinned shared-CDP readiness and fail-closed evidence controls; no HTTP-only visual PASS waiver. |
| #49 | `f893febf` durable machine-wide quota holds, legacy import, nonshortening rounded deadlines; this release's broker hydrates before starting. |
| #50 | Existing .8 explicit preserving `done --discard --tag`, concrete runoff refusal commands, failure-before-Done tests. |
| #51 | Existing full/compact/tiny text with persisted details; this release adds the main-Save Global Settings selector. |
| #52 | Existing .9 actual Codex bracketed-paste and hook/state acknowledgement fixes, with user-draft protection regressions. |
| #53 | Shared broker/caps/queues/input admission and restart/cancel/UI/CLI proof, independent of quota pacing. |
| #55 | `6805d2b3` authoritative score repair and reset-scoped submission metrics; cumulative histories stay labelled. |
| #56 | Overlaps #51; compact is now default with explicit Full/Tiny choices retained, without changing wake delivery. |
| #57 | Packaged exact Playwright/PNG modules, explicit module paths, CDP-only owned contexts and decoded-pixel readiness proof. |
| #58 | Validated typed journeys at requested sizes, scoped text assertions, distinct PNGs/numeric reports and stale-success replacement. |
| #59 | Sequential archived contender keeps remaining benchmark PASS held, accurate result text and explicit preserve/discard exit; watchdog recognizes that intentional hold. |
| #60 | Strict supported acknowledge/defer, material-evidence/prerequisite invalidation, separated ATTENTION holds, repeat-wake suppression and Done cleanup proof. |
| #61 | Executable sequential setup supplement, prose DB notes, isolated reviewer copies and explicitly authorized exact-snapshot evidence-only lifecycle. |
| #62 | Retained cache omission compatibility, precise field diagnostics, no corrupted-file replacement; actual 28-row table read-only validated. |
| #63 | Paused manual start reconciliation, same-card triage continuation, terminal audited STALLED/replacement hold, partial artifact preservation and no-action regressions. |
