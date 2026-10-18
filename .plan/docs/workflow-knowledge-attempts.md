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
- [x] Validate full suites/typechecks/build and exact committed export/local smoke before App-only publication;
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

## Publication and deployment

- Implementation committed/pushed through the Kanban GitHub App as **6f391dfad05e3b0bcea4abab5f4c632bf898df02**;
  secret guard passed and exact push/image CI **39152156645** passed through validated registry publication.
- Exact committed export built under isolated HOME/credentials and passed the owned local-pod overlay smoke, with
  owned cleanup verified and no provider turns/live data/browser launch. CLI SHA-256:
  `04b62b8cc11d5fd080bd47e4ac2b8d46491c90f8161b3a2e8a7c4b68d8e9bb0f`; full artifact-tree SHA-256:
  `c299a536c9b3ebf66a530f27e55a1f2f5bab25e9840f582518a58102328d4b9e`. Package dry run stayed product-only (27 files).
- Authorized application-only update completed through nonforced live `restart prepare` / `restart update` with
  explicit `KANBAN_RUNTIME_PORT=3484`, after a fresh zero-running-card check and private rollback snapshot.
- Production runs implementation **6f391dfa**, image id
  `20cf064c5acb473e92cede7aead59597a31ae9022695d764f2b6bf2211122d18`, digest
  `sha256:d659b32017a495b0a1ec759a6ec9b4e6baacea4fe3a44763150fdc4dec08c795`.
- Readback verified unchanged config and both stored boards byte-for-byte, mount sets, Chrome/Postgres identities
  and start times, ready Postgres, `/projects/foo` and `pawsome`, unchanged active Quadlet/inline credentials and
  host maintainer artifact, and unchanged 03:00 America/Los_Angeles / ten-minute reconciliation policies.
- Production phone/desktop Knowledge readouts passed in owned shared-Chrome contexts with mutation requests blocked
  and no page errors. The strict scoped attempt CLI returned an empty **recorded** history for an old unpinned card,
  explicitly marked reference provenance rather than approval; no pre-upgrade run was invented. HTTP/WebSockets
  passed on 127.0.0.1, ::1 and localhost. No live task, reference, plan, provider, model or secret was changed for testing.
- Private backup/proofs/readback/screenshots remain in the installation's `workflow-knowledge-attempts-6f391dfa`
  deployment ledger, never the product payload. No release/tag, new agent/session or real-model experiment was added.

This completes the native managed-context workflow inheritance/physical-attempt/prepared-rework slice. It does not
instrument every internal agent-CLI model turn or direct user keystroke, retroactively certify historical attempts,
automatically crawl shared Markdown/vault folders, or relax cross-project private-store access. Optional scoped graph
retrieval and efficiency recommendations remain separate roadmap work.
