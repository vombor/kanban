# Approved-plan knowledge handoffs

User asked to continue the next roadmap feature after the verified application/maintainer deployment.
Initial scope was source implementation and owned validation. Follow-up user authorization now permits commit,
push and application deployment after validation ("Nothing is running you can push and deploy at will"). No release,
secret migration, provider/model change, benchmark rerun, new agent/session or live plan approval/expansion is included.

Existing foundation already provides immutable project Markdown, strict own-project authorization, lexical
search, bounded section reads and project-index pointers. Preserve those owners; do not add an embedding/LLM
service or mistake ordinary publication/context for user-only execution approval.

- [x] Inspect knowledge storage/contracts, plan approval/index/expansion and launch/QA entry points.
- [x] Complete requested team-foo package cleanup: verify no shipped kit/artifact, remove stale installation-specific current documentation/examples, preserve historical design records and user-local kits, and guard the built-in package boundary.
- [x] Add immutable reviewed plan bundles (spec, exact breakdown and explicit knowledge revisions), persist content before recording user-only approval, and retain historical approval provenance.
- [x] Pin planned tasks to the approved bundle before card creation, preserving crash/retry identities and existing acceptance criteria/QA requirements.
- [x] Expose strict own-project task-context pointers and bounded pinned reads; append a small stable launch pointer rather than full shared documents.
- [x] Add revision-drift readouts; shared publication never silently replaces pins or manufactures plan approval.
- [x] Add explicit user-controlled pre-start adoption with physical-start serialization, immutable context history and audit; refuse running/previously started tasks and never reinterpret reference adoption as execution approval.
- [x] Add native review/readout UI and regressions for mutation-between-preview/approval, pruning, retries, privacy/isolation-off, stale revisions and missing/corrupt content.
- [x] Run formatting, both typechecks, product/UI tests/build and owned shared-Chrome/isolated smoke for the implemented milestone; reconcile actual completed versus pending scope.
- [x] Validate adoption races/authority/retention, native Backlog-editor confirmation and restart retention on owned phone/desktop contexts.
- [ ] Complete final source validation, exact committed-export build/local smoke, App-authenticated push/exact-SHA CI and authorized application deployment; preserve live configuration, boards, sidecars, credentials and maintenance schedule.

Initial discovery (before this source milestone): plan approval hashed only the breakdown; the spec could change
independently and was not durably available to dev tasks until landing. New approval now names the full reviewed bundle. Old
breakdown-only approvals/results must not be retroactively described as approving spec/contracts. Existing
expansion never starts cards and never links children to the plan itself; keep that invariant and ordinary routing.

Schema/route types must stay in narrow zod/type-only contracts so the web-ui router graph does not import the
bundle store, task worktrees, terminal manager or other server implementation. New task-context state uses the
canonical Kanban home and scoped knowledge tree; no installation identities or private-content global cache.

## Validated source milestone (2026-10-18)

- New narrow `plans-contract.ts` and `knowledge-execution-contract.ts` keep runtime stores out of the web-ui router
  graph. Plan review includes exact spec/breakdown bytes, explicit card/shared refs and protected user pins. The
  existing user-only approval route requires the previewed bundle revision and durably retains content first.
- Historical breakdown-only markers remain legacy provenance and cannot attach task contexts. New approvals retain
  earlier markers; an already reserved expansion cannot switch bundles. A later ordinary publication changes drift,
  not approved task context. Specs/JSON are bounded regular files inside the plan worktree.
- Expansion serializes before reservation, reuses chosen ids, attaches all task-specific/shared/protected refs before
  normal creation, and checkpoints confirmed creates. Native Done/delete history prevents re-creating a task removed
  before a create checkpoint. Ordinary routing, criteria-before-FINAL-STEP, no-start and no-plan-link invariants stay.
- Scoped task-context/get/read and attachment use strict own-project identity even with isolation off. CLI adds
  `knowledge task-context` / `task-read`; native detail UI offers metadata-only discovery and explicit bounded reads.
  Nonempty fresh launches append stable pointers, not bodies; blank/reused composers stay unchanged. Missing reserved
  pins/corrupt content refuse unpinned fallback, and board pruning does not remove retained references.
- `npm run check` passed: formatter/lint (one pre-existing unused-import warning in
  `test/runtime/pipeline/rework-limits.test.ts`), runtime/web typechecks, **3,008 product tests**.
- Full web-ui suite passed: **753 tests**. Fresh source `npm run build` passed.
- Shared-Chrome owned contexts passed **both phone and desktop plan-context fixtures**, including bounded retained
  reads, escaping, drift and runtime restart retention. All data and fake agent CLIs were disposable; no real model,
  live plan approval/expansion, provider or production mutation was used. Initial fixture workspace-name assumption
  failed before interaction and was corrected to discover its sole owned workspace; only subsequent passes count.
- `npm pack --dry-run --json --ignore-scripts` verified **27 package files**: only `default` / `team` plus the three
  model-only presets under `kits/`, no team-foo artifact. Its kit file was already absent; stale current examples were
  removed and `package-kit-boundary.test.ts` protects the shipped boundary. Installation-local kits remain untouched.
- No commit, push, release, deployment, schedule/folder change, secrets edit, actual plan action, or new agent/session.

## Adoption follow-up (2026-10-18)

Explicit adoption is implemented, never hidden behind reference publication or automatic rebase. User-only
`taskKnowledge.adopt` / `knowledge task-adopt` names the expected task context, old reference and exact current
replacement, with audit reason and exact-retry UUID. Original spec/breakdown/approval and document ids stay fixed;
the retained adoption chain validates one explicit replacement per revision against its published metadata/body.
Eligibility requires a Backlog dev task with no sessions/history/pipeline evidence/worktree/start reservation.

The physical session admission owner reserves the context durably under the same lock as adoption and injects
that exact pointer through the manager's prepared-request callback; runtime preflight is discovery/privacy only,
never the pointer source. Blank/failed/uncertain starts freeze pins too. Old adoption receipts stay readable after
start, but a new adoption cannot race into that attempt. Missing physical admission support refuses adoption.

Native Backlog editors expose Plan context without auto-saving/closing underneath the portaled dialog. Replacement
review is explicit/bounded, requires a user reason and confirm, retains exact-retry identity after uncertainty and
shows historical context reads. Owned shared-Chrome phone/desktop tests passed adoption, old/new reference reads,
restart retention and post-start freeze using disposable data/fake CLI only. Initial test locator selected the old
reference pane rather than the replacement pane; scoped it to the replacement section and reran both profiles.

Final source validation passed: `npm run check` (**3,015 product tests**, runtime/web typechecks, unchanged unrelated
lint warning), full web UI (**754 tests**), **33 maintainer tests** plus maintainer typecheck, fresh product build,
and both owned phone/desktop adoption/restart/freeze flows. No new real-model trial or live reference mutation.

Publication/deployment is now user-authorized but is not claimed complete until exact exported source/artifact
validation, App-authenticated CI and production readback finish. No host maintainer update is necessary for these
product-only changes; its immutable artifact, saved session/journal and 03:00 America/Los_Angeles schedule stay fixed.
