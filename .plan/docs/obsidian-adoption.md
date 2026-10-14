# Obsidian adoption for Kanban

Research date: 2026-10-14. This is an adoption proposal, not an implemented Kanban integration.

## Recommendation

Use Obsidian as the human-readable, durable knowledge layer across sessions: project briefs, decisions, runbooks,
research and dated benchmark summaries. Kanban owns execution and runtime facts. Project repositories own code and
versioned implementation specifications. Links connect these three; no second task/status/approval engine is needed.

This is particularly useful for keeping **instance-specific operational knowledge out of the bare product**:
deployment topology, provider endpoints, migration notes and local benchmarking belong in the user's vault.
Generic product behavior remains in the product's versioned documentation.

## Verified current installation

- Obsidian 1.14.4, Local REST API with MCP 5.4.0; the UI responds on the host's port 3000.
- Authenticated REST requests and a native MCP client handshake succeed on host port 27123.
- Inside the Kanban pod, `http://host.containers.internal:27123/` works; localhost at that port does not.
- MCP `vault_read`, `vault_get_document_map` and `search_simple` worked against the existing Welcome note.
- The plugin also advertises note listing, append/patch, move/copy, tags, attachments and filtered event streams.
  Patch schemas provide `ifMatch` concurrency tokens and duplicate-content rejection for retryable appends.
- The vault currently contains only `Welcome.md`. GitHub Sync is installed; Git is clean, but plugin settings
  including the REST API credential file are tracked. This needs correction before using Git sync for knowledge.
- Kanban has no Obsidian adapter, setting or note-link field yet. Nothing in this research changed the vault,
  configured agents, exposed credentials, or added an automatic job.

## Ownership and useful workflows

| Material | Owner/source of truth | Obsidian's role |
|---|---|---|
| Ideas and research | Human/project notes | Capture, link, discuss; then explicitly request a Kanban plan/task |
| Project brief and operating context | Curated project knowledge | A concise entry point for the orchestrator and planner |
| Architecture decisions | Versioned ADR when part of a code change; otherwise a dated knowledge note | Record the rationale and link evidence/commits/specs |
| Implementation spec and card breakdown | Repo `docs/specs/` + Kanban's plan/approval record | A linked overview or proposed requirement; never an approval authority |
| Card status, QA, landing, recovery | Kanban board/state/history | A linked completion summary, not an editable mirrored board |
| Agent-facing coding rules | Repo AGENTS.md/rules | Supplementary rationale and discoveries; launch-critical rules stay with the repo |
| Instance runbooks and migration history | User's operational knowledge | The long-lived record, outside the packaged product |
| Benchmark results | Finalized Kanban benchmark/calibration reports and raw metrics | Dated comparisons, conclusions and links to the source reports |

Highest-value starting workflows:

1. **Ideas → plans:** collect a requirement in an Inbox note, discuss it, then explicitly create a Kanban plan card.
   The planner produces the versioned spec/breakdown; the user approves it through Kanban. Editing a note's status
   never approves or starts work.
2. **Session handoff:** read the project's brief, decisions and relevant runbook when starting a new orchestrator
   conversation. Search first, read a document map, then only relevant sections rather than dumping the vault into
   every prompt. Leave a short dated handoff when a meaningful session ends.
3. **Discoveries → durable knowledge:** capture a reproduced problem, evidence, solution and applicability, linked
   to the card/issue/commit. Promote stable coding constraints to AGENTS.md; keep incident history out of it.
4. **Benchmarks → decisions:** export the finalized summary, then record conclusions with provider/model, configured
   context/output limits, agent/CLI version, hardware/server build, task set, results, durations and source links.
   Distinguish provider/harness failures from model quality. Never use the knowledge note as routing policy or a
   model allow list. Calibration reports aren't final until their run's `finishedAt` is set.

## Small initial vault structure

```text
Home.md
Inbox/
Projects/<project-key>/
  Overview.md
  Decisions/
  Runbooks/
  Research/
  Handoffs/
  Benchmarks/
Shared/
  Concepts/
Operations/
  Deployments/
  Migrations/
Templates/
```

Use stable project keys for folder names and display names in notes. A project overview links its repo, Kanban
workspace, active plans and runbooks. Keep notes short, dated and evidence-linked; avoid a transcript archive.
Suggested metadata: `type`, `project`, `status` (a knowledge lifecycle such as draft/current/superseded),
`updated`, `source` and an optional task/issue/commit reference. Knowledge status is separate from board status.

Good first notes are the product/instance boundary decision, the live deployment's migration runbook, a provider
benchmark index and a project brief template. Derive each from verified material rather than copying every
historical instruction, including obsolete ones, into the vault.

## Connecting agents without defeating project isolation

Direct native Obsidian MCP is useful for the user and their trusted host assistant now. Its discovered tools
operate across the vault and include overwrite/delete and arbitrary Obsidian command execution; the audit found
no per-project restriction in their schemas. Do not give each Kanban card the same unrestricted vault credential.

For Kanban-managed sessions, an optional **server-owned knowledge adapter** is the appropriate next feature:

- The user selects the service URL, secret reference and per-workspace folder mappings as instance settings.
  No vault location, project identity, endpoint or credential is baked into source/presets/image defaults.
- The server holds the credential; agents call narrow workspace-scoped Kanban read/search/append operations using
  their existing session identity. Reuse the existing strict caller and `workspaceProcedure` boundaries.
- User-authored mappings bind a workspace to its folder. Agent-editable project facts must not grant access to a
  different folder. A separately selected Shared knowledge folder can be read-only for opted-in projects.
- Start with scoped read/search and explicit context selection. The orchestrator can later write handoffs and
  discoveries to its own folder; cards can submit discoveries through the same project owner rather than editing
  global operational knowledge or personal notes.
- Resolve vault-relative paths inside the assigned prefix, reject escape/cross-project paths, scope searches too,
  and return bounded results. Do not proxy the entire upstream MCP tool catalog.
- Use document versions for edits and event/task identifiers for idempotent summaries. An optional asynchronous
  export must not block Done/landing, create another board writer or decide routing from note content.
- Native note/event search is enough initially. Add indexing/embeddings only if the collected knowledge actually
  makes native search insufficient. Event streams need reconnect/rescan handling: the plugin says missed events
  are not replayed.

## Adoption order

1. Correct vault Git exclusions for credential-bearing plugin data; deal with already-tracked copies/history as
   appropriate to the actual sync destination. Keep tokens out of notes and MCP configuration committed to Git.
2. Seed the small structure and a few curated notes; use it manually through the already-working REST/MCP path.
3. Trial one project: linked requirement, plan, implementation, handoff and benchmark summary. Measure whether
   it reduces repeated explanations without loading more context into agents.
4. Implement the opt-in scoped adapter if the trial demonstrates value, then explicit note context in the task
   editor and asynchronous completion/benchmark exports. Every new board field must survive normalizeCard.

The live pod's root→node migration is independent of this adoption: prepare/test on copied state, stop and back
up the old runtime, migrate UID/mount/HOME paths, then start the node-default image. An external Obsidian vault
is neither Kanban home state nor something `kanban home migrate` should absorb.
