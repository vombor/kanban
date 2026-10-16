# Cost-aware coordination implementation handoff

Updated 2026-10-15. The user approved checkpointing the tested connector/roadmap before implementing the knowledge
foundation. This slice was not deployed or used to configure the live vault/connector. The separate VS Code deletion
commit was already pushed.

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
- Authorized next foundation cards: `knowledge-store`, `knowledge-api-cli`, `knowledge-curation`; then approved plan bundles
  and task refs. `obsidian-scoped-graph` depends on scoped knowledge/curation and the connector slice below.

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

## Not yet implemented

Project knowledge persistence/curation, plan content bundles, agent read/search/graph tools, folder/Shared mappings,
graph traversal/pinning, usage/cost ledger/reports, scheduling/routing advice, budgets, integration checks, setup
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

## Safe continuation

Preserve the source changes. Do not treat the remaining roadmap as implemented, approved for runtime expansion or
permission to configure services automatically. Do not commit/push/deploy without a new user request. Tests use
isolated homes and shared Chrome contexts. For future agent graph retrieval, use native metadata and reapply scope
at every hop; never make a link, tag, note frontmatter or project-authored mapping an authority to widen access.
