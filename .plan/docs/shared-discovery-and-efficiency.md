# Shared discovery and efficiency reports

User authorized both features autonomously, including the standing validated push/deploy permission. Scope:
(1) Markdown-first scoped project/shared discovery plus optional Obsidian adapter; (2) read-only efficiency/timing
reports over existing native owners and new explicitly sampled observations. Coordination/integration advice is later.

- [x] Inspect canonical knowledge/connector, objective usage/lineage, running-time and card-stage owners.
- [x] Add user-owned shared-collection/project opt-in policies under canonical home paths, with stale-write protection,
  rename/home migration behavior and strict own-project reads even with isolation off/grants.
- [x] Implement bounded no-symlink project/shared Markdown discovery/read/graph; optional verified NoteJson adapter
  scopes every note/edge/tag/snippet and never grants a generic proxy, key, active-file or command endpoint.
- [x] Add source discovery/configuration UI/CLI without auto-publication, task adoption or execution approval.
- [x] Add durable sampled timing observations from native live-session/card-stage owners, with restart/gap uncertainty,
  bounded retention and no board/QA/landing/wake behavior changes.
- [x] Expose scoped task/objective/project efficiency reports: de-duplicated observed usage/price provenance, component
  attribution, overlap-safe elapsed windows and explicit unknowns/insufficient forecast evidence.
- [x] Validate privacy, revocation/stale source reads, symlink/path escape, connector absence/outage, graph budgets,
  timing overlap/restarts, usage deduplication and owned phone/desktop flows with fake inputs only.
- [ ] Run full source/build/exact-export smoke gates before App-only push; deploy only verified exact-SHA CI images,
  preserving configuration/boards, sidecars, credentials, real foo/pawsome identity and maintenance schedules.

No required Obsidian/network service, global supervising model, embedding service, real model trial, implicit provider change,
secret migration, live note/plan mutation or new agent/session. Shared collections are separate user-curated data,
not access to another project's private store. Mutable discovery never changes immutable attempt references.

Reference verified for the optional adapter: https://coddingtonbear.github.io/obsidian-local-rest-api/openapi.yaml
(`GET /vault/{pathToDirectory}/` → relative `files`; note JSON `content/path/links/backlinks/tags` via the documented
vendor Accept header). Do not use global search or invent `/graph`; indexing completeness remains unknown.

Follow-up user scope (2026-10-18): update the Lemonade preset and installed Cline provider to exactly Ornith primary
dev / MuseGlimmer secondary-fallback / Qwen36 QA, and one-model capacity/concurrency. Treat Ornith separately from
Qwen for review-family routing; preserve the fixed team workflow and assert no new model/plan vetting. Live provider
list/default and Lemonade/ Kanban capacities were updated with protected backups; unregistered historical notes
settings were not changed. The built-in preset/family classification still requires the validated image deployment.

Source validation: `npm run check` passed both typechecks and 3,045 product tests; `npm run web:test` passed 762 UI
tests; maintainer regressions passed 33 tests. Four owned shared-Chrome phone/desktop flows passed for canonical
knowledge plus discovery/efficiency. Only disposable data/fake CLIs and injected usage fixtures were used. Coverage
includes immutable policy identity/history across project-data rename, revocation fencing, source/graph budgets,
strict own-project authorization, timing coalescing/retention refusal, observer shutdown and retained plan descendants.
Publication/exact-export smoke/deployment are not yet claimed.
