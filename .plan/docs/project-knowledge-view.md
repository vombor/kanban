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
- [ ] Run both typechecks, full product/UI suites/build, exact-export/local smoke and App-only publication; deploy only
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
