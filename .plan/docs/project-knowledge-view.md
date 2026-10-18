# Project knowledge view

Continue the agreed native knowledge roadmap after deployed immutable plan handoffs/adoption. Build on existing
project-scoped knowledge owners, not another store, approval path or global supervisor. Standing user authorization
permits commit/push/deploy after owned validation; do not change credentials, providers, live notes/plans or schedules.

- [x] Identify the existing bounded list/read/search/history/proposal/mutation APIs and native dialog entry points.
- [x] Add a strict own-project permission readout for UI curation controls; preserve server authorization as authority.
- [x] Build on-demand document/kind/search/section/revision discovery and provenance with bounded slices.
- [x] Add safe Markdown rendering: raw HTML disabled, no remote images, relative/same-origin navigation or unsafe URLs.
- [x] Add proposal/base/current comparison, explicit publish/reject/pin confirmation and retained exact-retry ids.
- [x] Wire a project Knowledge dialog independently from machine-wide connector settings; scope-reset all private state.
- [x] Cover privacy, stale writes, mutation uncertainty, malicious content, pagination and scope changes with offline tests
  and owned shared-Chrome phone/desktop fixtures; no live reference mutations or real-model turns.
- [x] Run both typechecks, full product/UI suites/build, exact-export/local smoke and App-only publication; deploy only
  after exact-SHA image CI passes and preserve installation state, sidecars and maintenance calendar.

Project document publication and user pins remain reference curation, never execution approval or automatic task
adoption. Canonical immutable bodies/history survive independently of the optional Obsidian connector. Scoped vault
graph traversal, broader workflow attempt manifests and efficiency advice are separate work, not claimed here.

Source validation passed `npm run check`: runtime/web typechecks and **3,016 product tests**; the only lint warning
is the pre-existing unused import in rework-limits.test.ts. Full UI suite passed **761 tests** and the production
build passed. Owned shared-Chrome
phone/desktop fixtures exercise safe Markdown/URL behavior, kind/section/search/pagination, historical reads,
protected-document proposal publication, new-document proposal publication, stale-proposal rejection, explicit
pin changes and restart retention; the single created fixture task stays unstarted in Backlog.

Initial browser setup queried workspace directories before the first owned board initialization, then used a
concatenated accessible name that Playwright normalized with whitespace. Both were fixture issues: explicitly
initialize the disposable board without starting work and select by the stable title. The timed-out combined
run is not counted as passing; each corrected profile passed independently, and no leftover runner remained.

## Publication and deployment

- Committed/pushed through the Kanban GitHub App as **fe6291eb94a8efef5e8773cf30222c90f7615477**; secret guard passed.
- Exact committed export built with clean isolated HOME/credentials, passed the owned local-overlay pod smoke,
  retained full asset-tree evidence and verified cleanup without model turns/live data/browser launch. CLI SHA-256:
  `d1d142afe5632c60e0d2c349bedceffb87ecac27c871f9d29f565f7eea74e30e`; artifact-tree SHA-256:
  `e3e687c4ec853634a4b5827fa58df51f080b3c00ebe23015f78a710fa477d328`. Package dry run stayed product-only (27 files),
  no installation-specific kit or maintainer payload.
- Exact-SHA push/image CI **39144359166** passed, including bare non-root image validation and registry publication.
- Application-only production update completed through `restart prepare` / nonforced `restart update`, each with
  explicit `KANBAN_RUNTIME_PORT=3484`, after fresh zero-running-card and rollback-baseline checks. Production runs
  implementation **fe6291eb**, image id `f96e12bb21144c2a1009343f274a1cf66c898f0ae43671bea0a397813a6d2273`, digest
  `sha256:4879ffd7e7b3762a9a6f9b23c6b6e4b2e8a8c4fa3ae745b54fe78b1b651c5b51`.
- Readback verified configuration and both stored boards byte-for-byte, the same mount source/destination sets,
  unchanged Chrome/Postgres identities/start times, ready Postgres, actual `/projects/foo` and `pawsome` name,
  unchanged Quadlet/inline credentials/host maintainer artifact and unchanged 03:00 America/Los_Angeles plus ten-minute
  reconciliation policies. Mount enumeration order changed across container recreation; verification compares
  canonical source/destination/type entries, not incidental enumeration order.
- Production Knowledge and Proposals readouts passed on owned phone/desktop shared-Chrome contexts with mutation
  requests blocked and no page errors. No live knowledge document, proposal, pin or plan was changed. HTTP/WebSockets
  passed on 127.0.0.1, ::1 and localhost. Owned contexts closed; private backup/proofs/screenshots remain in the
  installation's `project-knowledge-view-fe6291eb` deployment ledger, never in the product package.

This finishes the project knowledge discovery/curation UI slice. Scoped Obsidian graph access, complete per-attempt
workflow manifests and efficiency advice remain separate roadmap work, not shipped by this change.
