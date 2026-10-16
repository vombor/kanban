# Cost-aware coordination implementation handoff

Updated 2026-10-16. Connector/roadmap checkpoint: `f727d067`. The user authorized committing and pushing the tested
knowledge foundation together with that checkpoint through the Kanban GitHub App over HTTPS. This commit records
the foundation and its resume state. Publication does not authorize a live restart/deployment or vault configuration.
Nothing in either slice has been deployed or used to configure the live vault. The separate VS Code deletion commit
was already pushed.

## Confirmed product decisions

- Canonical execution knowledge is Kanban-owned versioned Markdown, not an ever-growing prompt or a mutable vault.
- Project cards/QA/planners propose knowledge; the own-project orchestrator/user curates ordinary publication.
  User-pinned decisions and execution-plan approval remain user-controlled.
- Costs/routing/budgets roll out in report/recommendation mode first; enforcement is explicitly opt-in later.
- An optional app-level Obsidian REST connector is useful for a native, shared cross-project knowledge graph.
  Global Settings owns its configuration and future private-project/Shared collection mappings. Agent access is
  brokered/scoped; no unrestricted vault credential or broad command/MCP proxy is delivered to an agent.
- Shared collection publication is user-owned. Links/backlinks/tags never grant access to another private project.

## Durable plan

- Specification: `docs/specs/cost-aware-multi-agent-coordination.md`.
- Validated 27-card breakdown: `docs/specs/cost-aware-multi-agent-coordination.cards.json` (uses the actual existing
  plan schema/graph validator; it is a proposed implementation program, not a runtime-approved or expanded plan).
- Covers knowledge/revisions/proposals, approval bundles, task/attempt refs, tiny launch pointers, normalized usage,
  lineage/timing/cost forecasts, planning/coordination/routing advice, budgets, QA evidence, speculative integration,
  isolated setup caches, attention and optional system Obsidian graph/export capabilities.
- Foundation cards implemented: `knowledge-store`, `knowledge-api-cli`, `knowledge-curation`.
- Next cards: `knowledge-ui`, `approved-plan-bundles`, `obsidian-scoped-graph`; then task refs and stable agent
  bootstrap pointers. None of those dependent cards are claimed as implemented by the foundation.

## Implemented first slice: obsidian-system-connector

- Global Settings has a Knowledge section with optional enablement, endpoint, masked key rotation/removal, optional
  CA certificate, draft-only test and independent save. Mobile settings have a section selector.
- Narrow contract/API: `src/trpc/obsidian-connector-contract.ts`; strict-user get/save/test routes in app-router.
  Server-only implementation under `src/knowledge/obsidian/`, constructed once by runtime-server.
- Canonical private file: `<home>/secrets/obsidian-connector.json`, durable writes, 0600 file/0700 directory,
  expected-revision conflicts, no returned stored key, no auto-migration over damaged data.
- Saved certificate content is canonicalized to the public CA certificate, discarding extra pasted PEM data.
- Probe validates authentication (HTTP 200 is not sufficient), status/OpenAPI and native graph/search/document-map
  capabilities. It reads no note, saves no draft, follows no redirect, verifies TLS with an optional configured CA,
  bounds JSON size/time and sanitizes failures/credential-reflecting version metadata.
- API discovery against the installed Local REST API 5.4.0 confirmed NoteJson links/backlinks/unresolvedLinks,
  tags/frontmatter and native search; no generic `/graph` route or vectorization requirement was assumed.
- Secret guard recognizes the private stored Obsidian key, with integration coverage.
- Operator documentation: `docs/fork/obsidian-connector.md`.

## Implemented foundation: project knowledge, discovery and curation

- Canonical workspace paths under `<home>/data/<ws>/knowledge/`; immutable SHA-256 Markdown objects, hashed revision
  chains and durable locked manifest/receipts. Objects commit before the manifest, so interrupted writes retain the
  prior state and exact retries reuse the receipt. Missing/corrupt bodies/metadata are refused rather than reset.
- Publication, proposals, review and user pins all keep history. Cards can propose, the user/own-project orchestrator
  can curate ordinary knowledge, and user-pinned document changes/reviews/unpin remain user-only. No delete, alias
  or supersede API exists, and a plan-kind document is explicitly reference material, not execution approval.
- Strict workspace-scoped APIs for list/read/search/context/proposals/proposal body/history/mutation, even with
  isolation off or grants to another workspace. AppRouter imports only the narrow contract, not the server/store.
- Generic `kanban knowledge` CLI: source/section/revision discovery, bounded reads/snippets, publication and proposal
  workflow. Read-only/proposal commands are available to project agents; CLI hints route requests but authorize
  nothing. All operations call the server, never write its files in-process.
- Uses maintained Markdown AST/string/slug packages instead of a custom Markdown parser. Search is bounded lexical
  retrieval with no LLM/embedding call. There is no automatic full-plan prompt injection.
- Public usage/retention/boundaries documented in `docs/fork/project-knowledge.md`. The store has explicit ceilings
  and no automatic history eviction/GC. Project rename preserves historical author identities, which are provenance
  only, not an access lookup; the whole knowledge data tree follows rename/home migration.

## Not yet implemented

Knowledge browser view, plan content bundles, automatic task/attempt refs and launch pointers, Obsidian graph tools,
folder/Shared mappings, graph traversal/pinning, usage/cost ledger/reports, scheduling/routing advice, budgets, integration checks, setup
acceleration and export remain the dependency-ordered tasks in the breakdown. Enabling the connection does not yet
grant agent vault access, crawl a vault, expose secrets or activate any automatic policy.

## Validation

- Final `npm run check` passed with 2,851 runtime tests and both typechecks, including absent indexing metadata and
  secret-guard coverage. Existing unused-import warning in rework-limits remains untouched.
- Full web-ui unit suite: 709 passed; settings/connector focused suites: 17 passed after the scroll-lifetime fix.
- Phone and desktop shared-Chrome e2e: both passed using a fake REST server and throwaway Kanban; no agent tabs or
  live vault data were used. Includes unsaved test, stored-key masking, file mode, persistence and explicit removal.
- Final production build passed in an isolated source copy, with sourcemap upload disabled.
- Browser discovery inside the pod namespace initially missed the newly added spec; a fresh `PWTEST_CACHE_DIR`
  fixed collection. Do not bypass shared Chrome or install another browser for that issue.
- The settings nav tracks scrolling, not tab lifetime. Binding the credential draft to activeSection cleared it
  during ordinary scrolling. It now stays for the whole open dialog and clears on close/unmount; mobile navigation
  is a native section selector rather than a desktop-only button locator.

Foundation validation:

- Final full check: 2,872 runtime tests and both typechecks passed, including the explicit real rename/home-migrate
  tests. Existing rework-limits unused-import warning stays.
- Web-ui suite: 709 passed. Production build passed in a throwaway source copy with sourcemap upload disabled.
- Real CLI-through-server integration on a throwaway instance covers publication/exact retry, sections, search,
  proposals/review, pins/history, stale writes, invalid ids/scopes and confirms no cards were created.
- Focused store/RPC tests cover concurrent edit conflicts, failed commit recovery, immutable-object/manifest tamper,
  user-pin enforcement, stale proposals, strict identity/cross-project refusal, bounded sections and migration.
- Package-lock retains its existing two-space formatting. The Markdown dependencies add 34 packages, remove none,
  and change no existing package versions.

## Safe continuation

Preserve the source changes. Do not treat the remaining roadmap as implemented, approved for runtime expansion or
permission to configure services automatically. Do not commit/push/deploy without a new user request. Tests use
isolated homes and shared Chrome contexts. For future agent graph retrieval, use native metadata and reapply scope
at every hop; never make a link, tag, note frontmatter or project-authored mapping an authority to widen access.
