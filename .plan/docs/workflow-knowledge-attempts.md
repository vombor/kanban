# Durable workflow knowledge handoffs and attempts

Continue native execution context through QA, rework, escalation and runoffs using existing creation, IPC and
physical-start owners. No new board/QA/landing/wake writer or external supervising model. Existing user permission
allows validated commit/push/deploy; no live task/reference action or provider/model trial is part of validation.

User clarification: Obsidian is optional enrichment, never a runtime dependency. Project-folder Markdown is the
baseline; user-curated shared Markdown may live under the configured Kanban home (`~/.kanban` by default) and be
explicitly published/pinned into each opted-in project. Never treat another project's private store as a shared
fallback, or silently substitute mutable file/vault text for an immutable attempt pin. Legacy/manual tasks remain
usable through ordinary project Markdown even without knowledge manifests or a reachable connector.

- [x] Inspect task-context storage, physical admission, pipeline QA/sibling/rework and manual runoff creators.
- [x] Define narrow durable inheritance/attempt contracts and board attachment anchors, preserving legacy hashes.
- [x] Retain derived exact contexts before QA/escalation/runoff card creation through existing server owners.
- [x] Persist physical-attempt reservations/outcomes and explicit rework handoff contexts without treating queued
  input, PTY output or an uncertain launch as execution/acceptance evidence; keep failed/losing/pruned attempts.
- [x] Add strict scoped attempt retrieval and on-demand pointers/readouts for exact attempt references.
- [x] Test privacy, retries, corruption, missing anchors, restart/pruning and Obsidian-disabled/unreachable operation
  using project/shared Markdown inputs, fake CLIs and owned shared-Chrome contexts only.
- [ ] Validate full suites/typechecks/build and exact committed export/local smoke before App-only publication;
  deploy only a verified published image with an explicit-port prepare and unchanged installation/sidecars/schedules.

The new manifests are reference provenance, not a new approval or QA verdict. Snapshot labels identify the exact
requested review snapshot but must not invent which historical attempt produced it when that is unknown.

## Validated source behavior

- `knowledgeHandoff.rootRevision` survives core/browser normalization and ordinary card creation. A missing/mismatched
  managed attachment refuses reads/new starts and replacement prechecks run before stopping an existing process.
- Native QA/sibling creators and manual runoff `--from` attach same-project derived refs before creating cards;
  exact target retries keep the original context, including after later explicit source adoption. No sibling dependency
  links or automatic objective authority are introduced. Old unpinned/manual sources remain usable.
- Physical starts reserve/settle distinct attempt ids and inject exact attempt pointers through the existing native
  admission callback. Blank/failing starts freeze pins; unknown/duplicate identities never authorize replay. Explicit
  later runs retain their separate failed/started records. Rework retention uses the existing IPC request owner before
  clear/input/restart; its prepared handoff remains reserved, never misreported as delivered/accepted work.
- Strict scoped APIs/CLI expose paged attempts and `task-read --attempt-id`, with exact task/context selection and no
  arbitrary hash or foreign-project fallback. Native context UI shows inherited refs and on-demand attempt readouts.
- Project Markdown remains the baseline. A test explicitly publishes shared Markdown from the configured home into
  a project, removes its mutable source, and retains inherited attempt reads with all network calls unavailable.
  No Obsidian call is made. This is explicit file-based sharing, not an automatic shared-folder/vault crawler or
  permission to read another project's private store.
- Source `npm run check` passed runtime/web typechecks and **3,027 product tests** (the same pre-existing unrelated
  rework-limits import warning remains). Full UI suite passed **762 tests**; fresh production build and maintainer
  typecheck passed. Owned shared-Chrome phone/desktop flows passed source adoption, restart retention, exact physical
  attempt reads and a QA child retaining its original refs after its source adopts a newer reference. Fake CLIs only.
- Initial inheritance tests caught nested key-order changes across zod parsing; hashing now canonicalizes inheritance
  schema order while preserving pre-existing context hashes. A legacy pipeline runner fixture needed an injected
  no-context attachment owner rather than weakening production's fail-closed boundary. Failures were not counted as passes.

Final exact-export/local smoke, App publication, exact-SHA image CI and authorized deployment remain pending until
their receipts exist; live reference/plan/model/provider/secret configuration has not been changed by source validation.
