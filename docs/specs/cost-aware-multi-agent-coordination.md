# Cost-aware multi-agent coordination

Design status: agreed direction and phased implementation proposal, 2026-10-15. This document does not claim the
features below are implemented. Companion task breakdown: `cost-aware-multi-agent-coordination.cards.json`.

## Problem

Parallel sessions do not necessarily produce an efficient team. Agents repeat project discovery, miss decisions
made in other worktrees, change shared interfaces independently, and incur development, QA and rework costs that
are difficult to associate with one completed piece of work.

The current planner writes a spec and breakdown in its own worktree. `buildPlannedCardPrompt()` in
`src/plans/plan-expand.ts` says the spec becomes available in the repository after the plan lands. This leaves a
gap between approving/expanding a plan and making its shared knowledge available to every executing agent. The
planner currently compensates with self-contained prompts (`src/kits/plan-prompt.ts`).

Token accounting already exists for Claude, Cline, Codex and Copilot in `src/terminal/agent-token-usage.ts`, but its
public result is aggregate counts/models, not per-run priced observations. The team scoreboard separately prices
Cline/Codex work in `src/kits/team/bench/card-metrics.ts`. Neither is a complete objective-level cost account.

## Goals

1. Minimize estimated total metered cost per verified, landed objective while exposing completion-time tradeoffs.
2. Make project plans, contracts, decisions and discoveries visible to people and all that project's agents.
3. Replace repeated full-plan prompt payloads with small, stable references and bounded on-demand reads.
4. Preserve exact knowledge revisions and evidence used by an attempt and its QA.
5. Reduce incompatible parallel work, duplicate discovery, repeated setup and integration failures.
6. Recommend assignments using outcomes, costs, quota availability and capacity, with confidence and provenance.
7. Provide cost forecasts and budgets without pretending incomplete CLI measurements are accurate billing data.

Decisions confirmed by the user:

- **Canonical knowledge:** Kanban-owned, versioned Markdown; Obsidian is an optional presentation/export adapter.
- **Publication:** cards propose; the user or own-project orchestrator curates ordinary knowledge. User-pinned
  decisions are user-controlled. Plan approval remains user-only.
- **Rollout:** report/recommend first. Budget enforcement, automatic assignment and integration enforcement require
  separate explicit opt-in. No automatic policy changes during initial rollout.
- **System graph:** Global Settings has an optional Obsidian REST connector. Obsidian supplies its native relationship
  graph/search for explicitly shared cross-project knowledge; no vectorization pipeline is required. Kanban's pinned
  execution revisions remain canonical for tasks and approved contracts.

## Non-goals

- No shared model memory: retrieved text still occupies model context. Savings come from selecting and reusing
  relevant information rather than sending the entire corpus every turn.
- No automatic LLM summarizer, embedding service, vector database or paid discovery pass at startup.
- No second board writer, plan approval engine, QA verdict store, landing implementation or recovery loop.
- No model allow list, provider-dependent variation of the fixed team workflow, or silent change to saved assignments.
- No shared writable node_modules, build directories or application databases between cards.
- No cost-based weakening of acceptance criteria, required QA, vetoes, isolation, secrets or user-input protections.
- No access to another project's private knowledge by agents. User-designated system shared collections may be read
  by opted-in projects. An unrestricted Obsidian credential is never given to a card.
- No new global dashboard text leaked through the project-summary stream.

## User-visible behaviour

### Project Knowledge

The project has a Knowledge view with an overview, plans, contracts, decisions, discoveries and runbooks. Documents
show revision, author/publisher, source links, lifecycle state and user-pin status. Current and superseded versions
are distinguishable. Ordinary editing is explicit; card proposals appear in an inbox with a reviewable diff.

The project's agents can list/search/read this knowledge through workspace-scoped Kanban commands, independent of
agent vendor and worktree. Illustrative interface (proposed, not existing commands):

```text
kanban knowledge list --kind contract
kanban knowledge search "pagination" --limit 5
kanban knowledge read api-pagination --revision <digest> --section response-shape
kanban knowledge context --task <id>
kanban knowledge propose --document api-pagination --base <digest> --file proposal.md
```

Agents receive a small bootstrap pointer explaining discovery and the task's pinned knowledge manifest. They do
not receive the complete overview, plan, contract set or search corpus in the launch prompt. Required acceptance
criteria remain directly on the task for compatibility and reliable QA.

### Approve once, share before execution

The planner produces the repository spec/breakdown plus explicit contract documents where needed. The approval
preview names the exact bundle being approved. Publishing an approved bundle makes an immutable knowledge copy
available before the plan is landed and before its dev cards run. Plan expansion refers to that bundle, not a
mutable planner worktree. Publishing knowledge alone never approves, expands, starts or lands a plan.

Agents working against contract revision A continue against A if revision B is published. The UI highlights that
they are behind current knowledge. Adoption is an explicit rebase/rework operation, with affected tasks and audit
history shown; no live terminal receives an unsolicited replacement contract.

### Global Settings: optional Obsidian knowledge graph

Add a Knowledge section to Global Settings, distinct from Project Knowledge. The user can enable/disable a REST
connection, set a server-reachable endpoint, add/rotate/remove its masked API key, optionally provide the plugin's
CA certificate and test authentication/capabilities before saving. Empty installations require no connector.
Saved credentials are never filled back into a browser input; tests never persist a draft or crawl vault content.
HTTP is allowed with a clear transport warning for trusted deployments; HTTPS keeps certificate verification enabled.

The connection test reports native graph/search/document-map support and indexing observations. In the verified
Local REST API 5.4.0 OpenAPI, graph relationships are fields of `NoteJson`: links, backlinks and unresolvedLinks,
with tags/frontmatter and structured/fuzzy search. There is no need to invent a `/graph` endpoint or embedding pass.
Future adapters may expose extension traversal endpoints, but only after their schemas/capabilities are verified.

Later scoped graph access lets the user select Shared collections and map each project to its private collection,
plus opt that project into selected Shared collections. Traverse outgoing/backlinks/tags natively with bounded
depth/nodes/response bytes. Apply scope at every hop and filter both node and edge endpoints, search results and
tag counts: a link to a private project never grants access to it. Shared collections are read-only to project
agents; publishing cross-project/global knowledge is user-controlled. Cards may propose promotion to Shared but
cannot approve it. Own-project orchestrators retain ordinary local curation, not global vault administration.

The UI distinguishes source-vault graph notes from immutable execution revisions. An agent can discover related
shared knowledge, propose its use, and explicitly pin relevant source content into Kanban's task context; later vault
edits do not silently amend an approved contract. Disconnection leaves pinned knowledge and normal execution usable.

### Efficiency and costs

A task/plan efficiency view separates development, QA, rework/recovery and runoff attempts. It shows uncached input,
cache reads/writes, output, active time, setup/checks time, queue/hold time, measured coverage and estimated spend.
Related losing attempts are included in the objective total, not hidden when their cards are discarded/pruned.
Planning and orchestrator usage is separate shared overhead unless an explicit relationship permits attribution.

Metered providers show price estimates and sources; subscriptions show usage/quota state separately from marginal
metered spend; local providers show throughput/capacity and measured execution time. Neither zero marginal spend nor
a provider limit error means unlimited capacity. Missing provider, price or usage remains unknown, never zero.

Model recommendations explain sample size, first-pass success, expected QA/rework, estimated completion cost and
completion-time range. Sparse or incompatible history produces "insufficient evidence", not a confident winner.

## Design

### 1. Canonical knowledge and identity

Create a `src/knowledge/` domain boundary. Store data under `<home>/data/<workspace>/knowledge/`, using canonical
helpers in `src/state/kanban-home.ts`; this directory moves with project rename and home migration. No installation
paths, workspace identities or endpoints are embedded in the product.

Use immutable Markdown objects identified by SHA-256 plus a versioned, locked manifest of document metadata and
revision history. A manifest entry holds a stable document id, kind, short title/summary, section map, source refs,
current revision, previous revision, lifecycle, publisher and pin metadata. Revision history is retained after card
Done and planner worktree cleanup. Store content before atomically changing a manifest that references it. Use
`lockedFileSystem` and `durable-file` helpers; concurrent updates use expected revisions and explicit conflicts.

Kinds: overview, plan, contract, decision, discovery, runbook. Sources are structured references to task, approved
plan bundle, repository commit/path, issue or prior document revision. They identify evidence; they never authorize
an action. No status field inside Markdown changes an approval, policy or runtime state.

Knowledge APIs use a narrow `src/trpc/knowledge-contract.ts` and server-owned implementation to keep the web-ui
router graph light. Every operation uses `workspaceProcedure` **and strict identity**, including isolation off:

| Operation | User | Own-project orchestrator | Own-project card/QA/planner | Unknown/other project |
|---|---|---|---|---|
| list/read/search | yes | yes | yes | no |
| submit proposal | yes | yes | yes | no |
| publish ordinary document | yes | yes | no | no |
| pin/unpin or revise a user-pinned document | yes | no | no | no |
| approve execution plan | existing user-only plans route | no | no | no |

The own-project orchestrator cannot evade a user pin through deletion, renaming, supersession, restoring a prior
revision or creating an alias that changes the active project decision. Proposed contradictory documents remain
proposals until the user resolves the protected decision.

Metadata views are bounded and do not include complete content. Reads select a document/revision/section with
explicit truncation and continuation. Initial search uses a mature Markdown AST parser for headings and simple
lexical ranking; evaluate existing dependency support before adding a parser. Do not hand-build a Markdown parser.
The human renderer must disable raw HTML and unsafe link schemes. Search returns snippets and provenance, not
instructions. Tool/RPC responses treat agent-authored text as data, not a higher-priority instruction channel.

### 2. Plans, contracts and per-attempt context

Extend `plan-breakdown.ts`, `plan-index.ts`, `plan-target.ts` and the user-only approval preview for an explicit new
bundle version. Hash the spec, breakdown and declared contracts together. Old approvals remain valid only for their
legacy breakdown semantics; they cannot silently approve newly attached contract content. Upgrading a plan to a
bundle requires a new preview/approval. Record the approved content before expansion so retry/crash recovery cannot
lose it. Publishing is idempotent and creates no duplicate cards.

Extend planned cards with optional module/path ownership hints and contract/knowledge refs. Actual acceptance
criteria remain before FINAL STEP as today. Planner instructions may permit knowledge discovery/proposals, but
planners still do not create/start/link cards or approve a plan. A "draft" shared spec is never presented as approved.

Introduce a persisted per-attempt manifest: task/run identity, approved plan bundle, pinned document revisions and
selected section refs. Add necessary board fields to `RuntimeBoardCard`, `normalizeCard`, CLI request parsers and
pipeline sibling creation; defaults must preserve legacy boards. A server-derived read must verify task membership
and references, not trust a card-authored workspace id or external filesystem path.

Resolve references through `startTaskSession` in `src/trpc/runtime-api.ts`, sidebar launches and headless orchestrator
launches. Per-agent mechanics belong to adapter/profile modules, not agent-id literals in pipeline code. The generic
CLI is the baseline: it must work for every installed agent even where native MCP differs. Optional MCP exposes the
same scoped operations, not a separate store. Installed adapters must be verified before enabling native features.

Keep the bootstrap text and prefix ordering stable for provider caching. Never embed per-turn timestamps or changing
search snippets in the stable prefix. New launch files are git-excluded and use the existing cleanup owner. Knowledge
is read through the scoped interface, not a writable symlink from every worktree into the canonical store.

### 3. Usage observations, lineage and timing

Extend the existing `agent-token-usage` boundary with normalized per-session/per-model observations, retaining its
current aggregate interface. Preserve CLI-specific de-duplication, synthetic/error exclusions and cache accounting.
Facts include source id/position, observed time, session/worktree, model/provider when known, counts, completeness
and whether totals are delayed. Agent/provider gaps are explicit (Copilot's totals arrive on shutdown; missing
telemetry from another CLI remains missing). Never infer the historic provider/model solely from an edited card.

Add a server-owned append-only usage ledger, using idempotent source identities/checkpoints and durable writes. It
is not the team scoreboard and works for default-kit/manual work too. Preserve observations before worktree cleanup
and retain them after pruning. Incremental reconciliations must replace/update an observation's measured extent
without double charging copied messages or re-reading cumulative totals. Price-table revisions are pinned to the
calculation, not overwritten into raw counts.

Track an objective family across dev card, its QA rounds, rework, escalation siblings and runoff contestants. No
dependency links between racers/replacement cards are introduced. Reuse pipeline relationships but retain a durable
family record independent of board pruning. A new card inherits lineage through existing creators and request
parsers; an old unlinked card shows "unattributed" rather than guessed membership. Charge each observation once.

Planning/orchestrator work without attributable usage remains project overhead. If one session serves multiple
objectives, display it separately unless an explicit allocation is recorded; do not manufacture precise per-task
charges. Family outcomes distinguish landed, deliberately discarded, superseded, unresolved and harness failure.

Record transitions from their existing owners: session manager, checks runner, QA wait decisions, recovery/rework
state and Done/landing result. Read these facts for stage durations; PTY repaint is not useful progress. Report
overlapping waits explicitly rather than summing them into an impossible total. Show critical-path elapsed time
separately from sum of agent time. User review time is a visible delay, not falsely priced as provider spend.

### 4. Pricing, forecasting and budget boundaries

Use the existing prices/provider classification as the initial source of truth; extract a reusable price boundary
if core reporting needs it, leaving compatibility exports for kit callers. Estimated metered spend is not invoiced
billing. Unknown usage/provider/price cannot become $0. Subscription charges are not inventively allocated per turn;
local energy/hardware cost is optional user-provided information, separate from provider billing.

Report measured spend-to-date, coverage and an evidence-based completion range. Display the cohort/sample size and
include QA/rework/rescue/losing runoff costs in objective outcomes. Avoid survivorship bias by reporting failed and
unfinished cohorts too. A hypothesis of faster/cheaper selection must be evaluated against the same task cohort.

Budget settings are user-owned safety policy, not agent-editable routing facts. Initial mode is report. Optional
enforcement is a later, explicit user toggle with a visible response for new launches, QA, retries, runoffs and
headless wakes. Central admission must cover input that starts a cost-incurring turn as well as process creation.
Existing held-input/user-typing logic remains authoritative; never type around it.

Admission under enforcement is reservation-based so concurrent tasks cannot each spend the entire remainder.
Missing usage/price/reservation estimates follow an explicit user-selected policy, with uncertainty shown. This is
best-effort admission control: external CLIs can make further requests and delayed telemetry can overshoot. Never
label it a guaranteed provider-side spending cap. No abrupt kill of active shell tools or mid-turn model swap.
Capacity/quota/budget holds remain distinct and wake only when their actual condition changes. Resume/override and
policy changes are authorized, audited and restart-safe; the project's orchestrator cannot raise a user budget.

### 5. Parallel planning and assignment recommendations

Ownership annotations are hints, not rigid write locks: modules, likely edit paths, shared interfaces, task type,
risk and rough duration. Compare hints with actual snapshot changes over time. Analyze dependency graph, overlap,
contract producers/consumers and critical path at plan preview. Explain proposed serialization; never insert false
dependencies or auto-start cards solely because they share a group.

At runtime, show ready work, current overlap and scarce-provider holds by reading the existing owners. Start remains
through the existing task route/prerequisite claim; no second orchestrator is introduced. Initial scheduling is
advisory. Existing approved dependencies and manual actions stay authoritative.

Outcome-based assignment recommendations belong to `src/kits/` and connect through `dev-assignment.ts`/policy. Use
task-type/project cohorts, uncertainty, price estimates, quota state and capacity separately. Distinguish harness
and provider-account failures from model quality. Do not mutate running/saved assignments. Any later automatic
selection is opt-in at creation and uses the same kit-owned assignment path; manual choices always win. All models
remain permissible, and all team presets retain the same workflow.

### 6. Evidence-driven QA and integration

Build a bounded evidence manifest alongside current checks/QA reports: exact snapshot/base, changed files, relevant
contracts and section revisions, test commands/results, reproduction steps, artifacts and known-base failures.
Prefer links/read operations to huge pasted logs. Use the existing QA prompt's append-only extension points; the
legacy skeleton remains word-for-word intact. Dev-authored claims are evidence to verify, never a QA verdict.
Unknown, truncated or unavailable evidence must not justify PASS or skipping required checks.

Create combined candidate trees in disposable exports, never the live branch or a card's worktree. Candidate keys
include exact base tree, selected card snapshot ids, knowledge/contract revisions, checks configuration and toolchain.
Build candidates deterministically; report merge conflicts without inventing a merge resolution. Run existing
scripted checks with their environment stripping, redaction, isolated database setup and process cleanup.

Integration starts as a report linked to its candidate set; a speculative passing combination is not a PASS for
any different set or later base. A later optional landing precheck asks through the existing gate/veto mechanism,
revalidates exact trees and holds/refuses without doing side effects. It never finishes cards or lands itself.
Stale results are invalidated; no result silently bypasses per-card QA, vetoes, holds or approval choices.

### 7. Safe setup acceleration and attention

Instrument setup before optimizing it. Prefer native package-manager download caches over custom installed-package
sharing. Cache keys must include manager/lockfile, platform/architecture, node/toolchain, registry/config fingerprint
and relevant install mode. Credentials never appear in keys or reports. Copy/reflink into an isolated workspace;
never symlink mutable installed dependencies, databases or build output across cards.

Any reusable preinstalled artifact must come from a validated server-owned build, with integrity checks and no
embedded secrets. Card-written artifacts cannot poison another card's trusted environment. Native install scripts
and environment-dependent builds require correct invalidation or a fresh install. Measure cache hit rate and setup
time; a bad cache falls back safely, never downgrades dependency versions or skips required tests.

Add a project efficiency/attention view joining plan graph, proposals, contract drift, queue waits, budget reports,
integration conflicts and repeated failure causes. Every item names its existing owner and smallest useful action.
Do not create a second ATTENTION writer or wake source: extend watchdog facts/decisions where required. Text stays
project-scoped. Use current primitives/dark tokens and mobile/shared-Chrome tests; costs belong in the detail/report
view, not the card's deliberately token/time-only header.

The optional system Obsidian adapter holds credentials in the canonical home secrets directory and presents narrow
server-owned read/search/relationship operations, never a generic upstream HTTP or MCP proxy. Endpoint/test/mapping
configuration is strict-user-only in every isolation mode; agent requests cannot choose an upstream URL, header or
vault scope. Do not follow redirects with credentials. Support a configured CA, bounded JSON/schema discovery and
timeouts. Do not send upstream error bodies to logs/telemetry/UI. A local private key file is not an OS security
boundary against arbitrary code running as the same Unix user; it avoids handing credentials to ordinary APIs.

Graph operations use native note relationships/search and upstream indexing observations. A quiet cache is not a
guarantee of graph completeness. Cache graph results briefly with scope/revision identity; invalidation or event
gaps require rescan, not pretending a complete local mirror exists. No startup vault crawl or automatic embeddings.

Optional Obsidian export is asynchronous and idempotent, uses the same user-owned mappings/credential boundary,
and never blocks Done or drives approvals/routing. Imported/linked notes are distinct from canonical execution
revisions. See `.plan/docs/obsidian-adoption.md`; do not expose the vault's broad MCP tools or arbitrary commands.

## Risks

- Knowledge becomes another giant prompt: prevent through bounded metadata, section reads and retrieval metrics.
- Two documents disagree: explicit proposal/current/superseded states, pinned revisions and curator history.
- Approval drifts after publication: hash the entire execution bundle and require explicit reapproval for changes.
- Model-cost estimates sound like guarantees: show missing observations, price source, delays and confidence.
- Cohorts are too small or biased: no confident automatic winner; include failures, costs and task complexity.
- Admission is incomplete: cover new turns and shared launch paths, report overshoot limits honestly.
- Integration/cache artifacts are stale or poisoned: exact input identities, trusted producers and isolated outputs.
- Restart/data damage: immutable objects plus durable manifest/ledger writes, corrupt-file refusal and repair tests.
- Scope creep: deliver the dependency-ordered phases below; do not enable every mode during installation startup.

## Test plan

Each task in the companion breakdown owns focused unit/integration coverage. Cross-cutting required scenarios:

- Concurrent document/proposal edits, stale expected revisions, tamper/corruption, crash between object/manifest
  writes, idempotent publication, user-pin bypass attempts, unknown and cross-project callers in isolation off.
- Plan approved/expanded before land, planner worktree deleted, old approval compatibility, contract edits after
  approval, retries after partial expansion, revision pinning across rework/escalation/runoffs, browser normalization.
- CLI access from every adapter and headless/sidebar paths; no full knowledge body in a launch prompt; no auto-load
  of unrelated documents; section/search limits and cache-stable bootstrap text; shared-Chrome project UI.
- Usage copied/repeated/truncated across sessions, changing models/providers, Copilot delayed totals, absent CLI
  telemetry, unknown prices, pruned cards, family de-duplication, late measurements and restart reconciliation.
- Forecast confidence, harness exclusions, unfinished cohorts, overlapping waits, explicit overhead accounting.
- Report mode has no effects; enforcement opt-in, concurrent reservations, unknown-cost policy, retries/typed-input
  admission, active tools untouched, authorized overrides, holds visible and resumable after restart.
- Conflict/candidate analysis against real temporary git repos; no modification of live branches/worktrees; stale
  integration reports cannot satisfy a changed candidate; shared Done/landing path is still the only effect owner.
- Dependency/cache poisoning, key invalidation, isolated databases, no secret env/path disclosure, cleanup and fallback.
- Connector disabled/absent, authentication false despite HTTP 200, unsupported API, redirects, bounded responses,
  CA validation, draft tests without persistence, key rotation/removal, strict user-only configuration, stale saves.
  Scoped native graph traversal cannot cross through backlinks, aliases, tags or search into another private project;
  a configured system Shared collection is usable by opted-in projects only, with no global agent write permission.
- Root/web-ui typechecks including the AppRouter graph, full tests, secret guard, exact committed build and image smoke.
  All tests use temporary homes; browser tests attach to existing Chrome in their own contexts.

## Rollout / flags

1. Optional system Obsidian connection screen and capability test, alongside knowledge store/scoped discovery/UI.
   Empty projects remain usable; no service migration required. Configuration alone enables no agent vault access.
2. Approved plan bundles and per-attempt references; opt-in on legacy plans rather than rewriting old approvals.
3. Normalized usage/lineage/timing plus project cost reports. Keep existing card token/time presentation unchanged.
4. Advisory collision/critical-path/model/budget reports and smaller QA evidence payloads.
5. Speculative integration reports and measured, isolated setup acceleration.
6. Only after reports are validated: optional budget/assignment/integration admission. Scoped system Shared graph
   retrieval and optional Obsidian export use the canonical knowledge/pinning foundation and user-owned mappings.

Initial success measures: estimated family cost per landed objective; first-pass success and rounds; total time to
land; discovery/context bytes; measured prompt-cache coverage; setup time; integration/landing conflict frequency;
human decision count/time; telemetry completeness. Compare similar cohorts and report regressions, not just savings.

## Open questions

These do not block the report-first knowledge foundation, but require explicit decisions before enforcement:

- Task-category vocabulary and minimum cohort size/confidence for model recommendations.
- Per-task/plan/project budget amounts, reservation estimator and policy for unknown/delayed spend.
- Whether integration gating should be opt-in per kit/project or limited to shared-contract task groups.
- Knowledge retention/size limits and whether stale contract revisions should warn or require explicit adoption.
- Which package managers receive artifact acceleration after setup timing identifies a useful benefit.
- Obsidian mapping/credential configuration and whether exports are snapshots or a current-view projection.
