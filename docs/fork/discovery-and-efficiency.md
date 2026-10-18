# Reference discovery and efficiency reports

## Markdown-first reference discovery

Open **Project knowledge → Explore reference sources**. The baseline needs no connector: discovery reads the
project's root `README.md`, `AGENTS.md`, `CLAUDE.md` and Markdown under `docs/`. It never reads another project's
private knowledge store. Search results, links, backlinks and tag counts describe only the current bounded scope.

The user can define immutable Shared collection identities and explicitly opt each project in. Local Shared
Markdown lives at `<configured Kanban home>/data/knowledge-collections/shared/<collection-id>/`; definitions are
in `collections.json` in `knowledge-collections`, and opt-ins are the project's `knowledge/source-policy.json`.
There is no default shared grant. Definitions contain no workspace ids; project policy moves with project data
during rename/home migration. Retained policy revisions refuse writes at their ceiling rather than evicting history.
Use a new collection id for a different mapping; existing identities cannot be silently repointed.

Optional Obsidian sources reuse **Global Settings → Knowledge** connector configuration. Explicit private-project
and Shared vault folders must not overlap. The broker uses only bounded authenticated vault GETs and documented
NoteJson link/backlink metadata, never global search, an arbitrary proxy or active-file/command endpoints. Credentials
remain server-side. Missing connector or vault outage leaves project/shared Markdown usable; completeness is labelled
unknown. No Obsidian installation, embedding service or supervising model is required.

Inventory visits at most 1,000 entries to depth six and loads at most 100 notes / 2 MiB of text. Individual Markdown
reads are bounded to 256 KiB and page to 16 KiB. Graph depth is at most three, with 30 nodes and 120 returned edges.
Symlinks, hidden/escaping paths, invalid UTF-8 and terminal-control text are refused. Linux reads also verify the
opened descriptor's path. Vault requests have byte/request/deadline ceilings and refuse redirects and credential echoes.
Results are bounded views, not a promise that the entire collection was indexed.

Discovery is **mutable reference material, not execution approval**. Reads require the exact discovered content hash;
changed content refuses rather than substitutes new bytes. A final policy fingerprint check fences grant revocation
during reads. Publication into the canonical immutable store, approved-plan bundles, task pinning and explicit
pre-start adoption remain separate existing operations. Safe Markdown still disables images and unsafe/relative or
same-origin navigation.

CLI: `kanban knowledge sources --help`, `source-read --help`, `source-graph --help`, `source-policy --help`,
`source-opt-in --help` and `source-collection --help` describe bounded search/read/graph and user-only policy commands.
Agent reads stay strict own-project even when isolation is off or
the caller has a cross-project grant. Agents cannot curate discovery policies.

## Read-only efficiency and timing

Open **Project knowledge → Efficiency reports** (also a desktop top-bar action), or use
`kanban knowledge efficiency --help`. Project, recorded task, objective family and retained plan-descendant scopes
are supported. Plan descendants include retained QA/fallback/runoff context bindings even after cards are pruned;
historical/unlinked work is not retroactively attributed or certified.

The server samples existing live-session summaries and native pipeline card stages every ten seconds. Agent active
time is a delta of the native cumulative running counter, not terminal output or a hydrated dead process. Stage
occupancy requires consecutive observations; transitions/short waits can be missed. Contiguous intervals coalesce.
Restart/long sampling gaps are not charged as active time. The durable, bounded per-project
`efficiency-timing.json` retains evidence; corrupt history or retention ceilings stop sampling without eviction or
reset. The observer closes before runtime teardown and never creates a task, wake, QA verdict or landing action.

The report distinguishes summed task/stage occupancy from the **union** of sampled elapsed windows. Neither is a
critical-path completion time. Retained explicit objective usage is deduplicated across request versions/copies,
with highest retained token counters and conservative observed price estimates plus price-table provenance.
Objective-family observations before explicit attachment are excluded. No report triggers model calls or changes
routing, requirements, approvals, holds, verdicts or work scheduling.

Coverage is partial/unknown. Observed subtotal is not total spend or an invoice. Missing usage/pricing stays unknown,
never zero; local/subscription marginal estimates do not mean unlimited capacity. Planning/orchestrator overhead,
unlinked work, same-card rework cost separation and setup/provider-wait decomposition are incomplete. A completion
forecast model is **not implemented**; forecasts are explicitly insufficient evidence. No spending-cap guarantee or
acceptance authority is provided.

## Lemonade lineup (user selection, 2026-10-18)

`team (lemonade)` names exactly these three models, all through Cline:

| Role | Model |
|---|---|
| Primary dev | `Ornith-1.5-35B-A3B-GGUF-Q4_K_M` |
| Secondary/fallback dev | `MuseGlimmer-Q4-DFlash-Test` |
| QA (also existing QA-model reuse for planning) | `Qwen36-35B-A3B-UD-Q6_K-QA` |

Ornith is a distinct routing review family from Qwen by explicit user policy, not a claim about independent base
architecture. The standard team different-family safeguard remains enabled. No new model/plan-vetting result is
asserted, and no real-model experiment is needed. Model capacity and provider concurrency are one; the preset only
recommends these settings and never edits a user's provider list itself. Deliberate serialization does not warrant
recommending three resident models. Existing card assignments and historical project overrides are not rewritten by
a preset update.
