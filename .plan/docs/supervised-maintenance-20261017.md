# Supervised daily maintenance — first robustness slice

User approved the recommended first slice with “Go”: durable maintenance jobs, completion tracking, restart-safe
reconciliation and concise outcome reports. No release, live-pod upgrade/restart, model/credential policy change,
benchmark rerun/promotion or new agent/session creation is authorized. Existing daily fixing authorization remains.

## Scope / architecture

- Reusable host-only maintenance supervisor, packaged separately from the web/runtime entry points. Kanban itself
  remains maintained outside the pod. This owns no project board move, QA verdict, landing or recovery loop.
- User-owned installation config supplies repo/directory, existing OpenCode session, CLI and App bridge references;
  no installation identities or secrets in product defaults. Journal paths use an explicitly selected canonical
  Kanban host-maintenance home, separate from the live pod home.
- Durable locked job/check/event state. Pin starting commit, issue numbers/material fingerprints and target identity.
  A process restart reconciles existing journal entries instead of reconstructing them from chat or replaying POST.
- OpenCode V2 normal CLI/API discovery/authentication only. Queue delivery, exact input id, scoped inbox/message
  metadata and active-session observations; no raw provider bodies/prompts/credentials in state or reports.
- Explicit worker progress/result is evidence, not completion authority. Independent App-backed verification of
  selected issue dispositions, pushed commits and required exact-SHA CI gates precedes a completed state.
- Admission uncertainty stays held: inspect input receipt/inbox/delivery through reads, never automatically replay
  an uncertain mutation. Blocked/stalled work has a useful checkpoint/reason and does not spawn competing work.
- Existing 03:00 daily check remains; add scheduled reconciliation of admitted jobs, concise CLI/report output and
  safe migration of installation wrappers/receipts. Do not wake an agent for an empty issue list.

## Plan

- [x] Verify current OpenCode V2/CLI response contracts and existing maintenance/locking/auth boundaries.
- [x] Add small typed config/job/result/observation contracts and durable locked journal with retry identities.
- [x] Add pure lifecycle/admission/evidence decisions, bounded failure handling and concise reports.
- [x] Add scoped OpenCode/App/Git adapters and packaged host CLI with operator/agent boundary checks.
- [x] Add fake-driven end-to-end, crash/uncertain-admission/duplicate/stale-evidence/secret-redaction regressions.
- [x] Build/typecheck/test and validate dry/read-only operation without launching real model work or changing the pod.
- [x] Wire the user-authorized host daily/supervision schedule with installation-only config and verify receipts.
- [ ] Commit/push scoped changes under standing authorization, verify CI, document outcomes and reconcile this plan.

## Verified contracts / important discoveries

The live Desktop V2 CLI is 2.0.30; ~/.local/bin/opencode is a GUI launcher, not the automation CLI. Public V2 API
documents `/api/session/{id}/prompt`, queue delivery and stable message ids; delivered messages and pending inbox
entries are separate. `/api/session/active` reports this process's running drains, not job success. Assistant metadata
in the current conversation has no input-parent id, so unrelated assistant success must not finish maintenance work.
`message?order=desc&limit=...` returns `{data,cursor}`; do not unwrap away the cursor and accidentally claim complete
history. Admission POST timeout is not proof of non-delivery, and an agent result alone is not proof of CI/acceptance.
Existing host timer only records no-work/queued/admission uncertainty, not execution/completion; that is the gap.

Implementation now lives in `src/maintenance/`, with a separately bundled `kanban-maintenance` CLI and an
operator-configured read-only App bridge. It owns no runtime board/recovery operations. Worker result/progress
files are advisory; exact-SHA CI, pushed ancestry and unchanged issue/comment evidence are independently verified.
No model request or pod restart was performed during implementation. The signing key stays inside the existing
running Kanban credential broker.

## Continuation checkpoint

A native V2 compaction request was admitted once with id `msg_supervised_maintenance_checkpoint_20261017`; it is
conversation context management, not a reset, new model/permissions setting or pod operation. Continue implementation
from this plan after compaction, without repeating completed API discovery or prior #64/#65 release/deployment work.
Remaining validation/installation/publication steps are pending, not complete. Preserve host timer's existing daily receipts and App
credential helper; read before editing. Suggested next concrete files: typed contracts, durable locked store, pure
supervisor decisions and fake-adapter tests. Reuse `src/fs/locked-file-system.ts`/durable-file instead of guessing a
lock implementation. Initial recovery may reconcile and safely hold/handoff; it must never automatically replay an
uncertain prompt, switch models, spawn sessions, reissue completed work or treat a worker report as authorization.

## Validation so far

- `npm run check`: passed (2,955 tests; both typechecks; repository Biome check). One pre-existing unused-import
  warning in `test/runtime/pipeline/rework-limits.test.ts` is outside this slice and was not changed.
- UI: all 722 tests passed. Maintenance: 27 Vitest regressions, including an actual owned-child SIGKILL at the
  durable admission boundary, plus seven offline Python GitHub evidence tests (run by the Vitest bridge test).
- Final production build passed, including `node --check` on all three actual bundled artifacts. Installed standalone
  artifacts use explicit `.mjs`; this also avoids Node module-mode ambiguity outside the package's `type: module`.
  A duplicate source/banner shebang was caught by the first installed preflight before any unit/admission changed,
  corrected, and turned into a production-build parse gate. Earlier private artifacts remain preserved.
- History-preserving install preparation ledger: private `supervised-maintenance-20261017-sun9l1mw`; the only
  legacy daily receipt was independently checked as `no_open_issues`, not queued/completed. Legacy scripts remain.
- Blocked jobs intentionally retain their reservation for human handoff; no automated resumption/replacement
  session, operator override/reauthorization protocol or OS-level same-UID sandbox is claimed by this first slice.

## Installation / live boundary

- The original daily script, service/timer and 03:00 October 17 no-work receipt are preserved. A service drop-in
  selects the immutable reviewed host bundle; its explicit host Kanban home is separate from the live pod's data.
- Daily admission remains 03:00 America/Los_Angeles. The new `kanban-maintenance-supervisor.timer` reconciles admitted
  jobs every ten minutes and sends no agent input. Both real systemd-environment service checks returned success.
- The old no-work receipt was copied with its original timestamp and explicit `legacy_no_work` source, not upgraded
  to a job/verified-completion receipt. Validation re-used it idempotently; no real model prompt was sent.
- Installed read-only preflight confirmed repository/branch, existing session identity/directory and App-only access.
  It found newly open issue #66; that is for the next normal daily admission, not an extra fix prompt in this turn.
- Host artifact hash: `5d9cad39a4f5dd5255e04dadd56b6bbcc4797bd1db9a60985d58d63495f2ac1d`. Private config and installation
  ledger hold installation paths; no identities/secrets were added to product defaults or the npm payload.
- Live Kanban remains `a8291171d973c39074d773aebbb82ec6af750ad9`, UID 1000. No pod restart/update, release, credential
  or model-policy change, benchmark rerun, verdict change, additional agent or session creation was performed.
- Scoped repository publication and exact-commit CI verification remain pending; the implementation is not yet
  described as fully published/verified until that last plan item is satisfied.
