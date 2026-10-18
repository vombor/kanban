# Versioned project knowledge

The knowledge foundation gives the user and a project's identified agents a shared, durable reference store. It
does not automatically load every document into a launch prompt or start an LLM/indexing service.

Documents are ordinary Markdown, with separate validated metadata: stable id, kind, title, short discovery summary,
tags and optional task/document/repository/URL source references. Kinds are overview, plan, contract, decision,
discovery and runbook. Markdown frontmatter is content, **not** an approval, pin or policy mechanism.

Storage is `<home>/data/<workspace>/knowledge/`: immutable SHA-256 Markdown objects plus a locked, durable revision
manifest. Publication records full metadata, author/publisher, parent revision, content hash and section map. Pins
are revisioned too, so concurrent changes cannot silently overwrite them. Old bodies remain readable after edits,
task cleanup, project rename or home migration. Corrupt/missing objects or invalid manifests are refused, not reset.

## Discover only what you need

All commands use the running server, strict caller identity and the selected project. `--project <id-or-path>` is
explicit; otherwise an agent uses its informational session-workspace hint, or the CLI finds the registered project
containing cwd. The hint does not grant access. Agents never read another project's private knowledge, even with
isolation off or a broader isolation grant.

```sh
kanban knowledge context --project example --json
kanban knowledge list --project example --kind contract --limit 10 --json
kanban knowledge search 'pagination' --project example --limit 5 --json
kanban knowledge read api-pagination --project example --json
kanban knowledge read api-pagination --project example --revision <sha256> --section response-shape --json
```

List/context return metadata pointers, not complete plan bodies. Reads return a Markdown AST-derived section map
and bounded content (4,096 UTF-16 units by default, maximum 16,384). A truncated result includes its pinned revision
and next offset; continue with that revision and offset to avoid mixing revisions. Search is lexical over this
project's current documents, with bounded snippets, not a paid embedding/model operation.

`context` prioritizes user pins and returns up to 30 overview/plan/contract/decision pointers. It is **a project
index, not an approved task context or plan approval bundle**. The separate plan handoff below pins exact references
to planned dev tasks without changing the meaning of ordinary publication or project discovery.

## Reviewed plan bundles and task handoffs

New user-only `plans.approve` approvals name an immutable reviewed bundle: the spec's exact bytes, the exact
breakdown JSON and selected published knowledge revisions. Optional `knowledgeReferences` entries in the breakdown
or on a card use `{ "id": "api-contract", "revision": "<full SHA-256>" }`; top-level entries are shared, card entries
are specific to that card. The bundle also includes the user's current protected pins. Conflicting selections,
invented/missing revisions, a selection shadowing a protected pin, or more than 40 documents refuse review rather
than silently dropping context. Specs and breakdowns are bounded regular files inside the plan worktree, each at
most 262,144 UTF-8 bytes. A spec must also fit the bounded Markdown heading map.

The approval dialog identifies the spec, breakdown and bundle hashes plus selected knowledge metadata; review the
plan's files before confirming. A spec-only edit or protected-pin change between preview and approval changes the
bundle identity and is refused. Immutable content commits before the approval index. Historical breakdown-only
approvals remain explicitly **legacy breakdown only**; they are not upgraded by publication, preview or expansion.
A new user approval retains the earlier marker in `approvalHistory`. An already reserved expansion cannot switch
to another approved bundle.

Expansion validates the current spec/breakdown against the retained user approval and creates from the exact
retained breakdown. Later shared-document publication does not reselect the task's knowledge. It durably reserves
ids, then attaches every task's references before the first ordinary Backlog card creation. Task-specific entries,
shared entries and protected pins are retained in `knowledge/task-contexts.json`. Expansion stays serialized,
crash retries keep their ids, and confirmed creations are checkpointed. A confirmed task pruned during an unfinished
expansion is not recreated by retry; native Done/delete history also protects a task removed before its create
checkpoint was recorded. Cards keep ordinary kit routing and acceptance criteria before `FINAL STEP`,
including a dev-task reference pointer for QA; expansion never starts tasks or links them to the plan card.

```sh
kanban knowledge task-context <dev-task-id> --project example --json
kanban knowledge task-read <dev-task-id> --project example --part spec --context-revision <context-sha256> --json
kanban knowledge task-read <dev-task-id> --project example --part breakdown --json
kanban knowledge task-read <dev-task-id> --project example --part document --id api-contract \
  --context-revision <context-sha256> --section response --offset 0 --limit 4096 --json
```

These use the strict own-project API even with isolation off or a grant. Reads accept only a retained task context
and its pinned parts/documents, never an arbitrary content hash or mutable-worktree fallback. They use the same
bounded slices/section maps as ordinary knowledge. Task/plan cleanup and board pruning do not remove these pins.
Missing/corrupt bundles or missing reserved handoffs refuse reads/new launches rather than silently going unpinned.
The task-context store is bounded to 2,000 retained tasks, 100 context revisions per task and 8 MiB; no history is
evicted automatically.

New nonempty ordinary agent launches append a small stable pointer, not full spec/document bodies. Blank composers
stay blank and reattaching a live session does not inject a prompt. The detail view's **Plan context** dialog loads
metadata only when opened and reads bodies only on request. It reports published revision drift without changing
pins; phone/desktop reads and restart retention are covered by owned shared-Chrome fixtures with fake CLIs.

## Workflow inheritance and per-attempt references

Native QA, escalation and runoff creators pass a same-project source reference through the existing server creation
owner. The owner durably attaches a derived context **before** creating the ordinary card; manual `bench runoff
create --from <task>` uses the strict own-project user/orchestrator attachment route before creating each contender.
The copy pins the source's exact current context, including any explicit user adoption, not today's document/vault
versions. Exact target retries retain the original copy even if an unstarted source later adopts another reference.
QA inheritance records its exact requested review snapshot; that is not a claim about which historical agent run
produced the snapshot, and it never rewrites QA verdicts or grants implementation approval.

Cards retain a `knowledgeHandoff.rootRevision` attachment anchor through ordinary CLI/server creation and browser
normalization. This is the initial attachment identity, not a mutable latest-reference selector. A missing/mismatched
anchored context refuses native reads/new starts, and replacement prechecks refuse before stopping an existing
process. Old cards without anchors remain valid; their existing retained context is used where present, otherwise
ordinary project Markdown remains the baseline. Inheritance remains in the project's private context file after
Done, worktree cleanup or board pruning, with bounded depth and exact source revision checks. Child contexts do not
create prerequisite links, bypass holds, change routing, promote models or manufacture objective membership.

Physical admission now retains a distinct attempt reservation before every new pinned session, including blank
composers, explicit restarts and attached automatic restarts through ordinary dispatch. It settles `started` only
from the native manager's matching task identity and actual start clock; failures or interrupted/unknown outcomes
stay `uncertain`/`reserved`. Those labels describe physical session admission, not prompt delivery, progress or QA
acceptance. Reusing a physical attempt identity refuses replay. Explicit later starts retain separate records,
including unsuccessful and losing runs; no count/cost/evidence is erased when a card is discarded.

Rework retains a `rework_handoff` reference record through the existing IPC action channel before typing or replacing
a session, including started-check retries. Its identity is pinned to the retained rework request, round and known
snapshot. It remains `reserved`: queued input, a clear command or terminal output does not certify that the model
processed the rework. A new physical session, if needed, has its own separate native outcome. The legacy QA prompt
skeleton remains unchanged; short pointers travel alongside it, and a clear command remains a clear command.

```sh
kanban knowledge task-attempts <task-id> --project example --limit 10 --json
kanban knowledge task-read <task-id> --project example --part spec --attempt-id <attempt-sha256> --json
kanban knowledge task-read <task-id> --project example --part document --id api-contract \
  --attempt-id <attempt-sha256> --section response --json
```

Attempt reads resolve only that same project's task/retained attempt/context; arbitrary content hashes and foreign
task attempts are refused. An explicit context revision cannot contradict the selected attempt. The Plan context
dialog exposes inherited-source provenance and an on-demand paged **Inspect retained attempts** view. Physical
starts point at their exact retained attempt rather than an unpinned `latest` document. Attempt records are bounded
to 1,000 per task within the existing 8 MiB context store; hitting a ceiling refuses new writes, never evicts history.
Pre-upgrade runs without manifests remain unknown, not retroactively relabeled as observed attempts.

## Explicit pre-start reference adoption

Only the user can adopt a replacement revision of a document already selected for a task. Adoption is not a new
plan approval: the reviewed spec, exact breakdown, acceptance criteria, plan approval and any QA/verdict history
remain unchanged. It does not add/remove document identities, replace the approved plan bundle, start work or grant
execution permission. Material scope/requirement changes still need their ordinary explicit approval, not a
reference-adoption workaround.

The task must be provably unstarted: a Backlog dev card with no current/persisted session, pipeline evidence,
task history, existing worktree or retained physical-start reservation. Missing/unreadable evidence refuses it.
The native **Plan context** dialog is available in the Backlog editor as well as task details; it offers bounded
replacement review, an explicit reason and confirmation only when eligible. Opening/readout never adopts.

```sh
kanban knowledge task-adopt <dev-task-id> --project example --id api-contract \
  --expected-context <context-you-reviewed> --expected-revision <currently-task-pinned-revision> \
  --revision <exact-current-published-replacement> --reason 'Reviewed correction; acceptance unchanged' \
  --request-id <uuid> --json
```

The strict user-only server route rechecks eligibility and exact context/document revisions. The replacement must
still be the selected published current revision, checked under the knowledge manifest lock. A concurrent edit or
adoption refuses rather than choosing a newer revision. The write retains the previous context, user/time/reason,
parent revision, selected replacement and request id together. An exact retry returns its retained receipt even
after a start; reuse with a different choice refuses. Old contexts remain readable through `--context-revision`.
The UI displays adoption history and a previous-reference read, without relabeling original plan approval.

Physical starts reserve the exact task context under the **same durable task-context lock** before preparing/spawning
the agent. That physical admission owner injects the reserved pointer, not a preflight snapshot. Adoption therefore
either commits before the reservation and reaches that launch, or loses the race and is refused. Blank composers
also reserve/freeze pins but stay blank. Failed/uncertain starts retain the reservation; there is no automatic
refund, unfreeze or retry. Attached automatic restarts return through ordinary runtime admission. An installation
without the physical admission hook refuses adoption rather than advertising a preflight-only safety guarantee.

## Markdown baseline and optional services

Obsidian is optional enrichment, **not a hard dependency** for Kanban, launches, plan handoffs or attempt reads.
Ordinary agents can continue reading the project's Markdown (`README.md`, `AGENTS.md`, `docs/`, specs/contracts)
through their normal workspace tools. Legacy/manual cards without knowledge manifests are valid; native execution
does not require connecting or importing a vault.

Versioned project references can be published directly from project Markdown. For reusable cross-project guidance,
the user may keep a separately curated Markdown library under the configured Kanban home (`~/.kanban` by default)
and explicitly publish the chosen file into each intended project's scoped store:

```sh
kanban knowledge publish api-contract --project example --kind contract --title 'API contract' \
  --file docs/contracts/api.md --expected-revision none --json
kanban knowledge publish shared-review-guide --project example --kind runbook --title 'Shared review guide' \
  --file /path/to/configured-kanban-home/shared/review-guide.md --expected-revision none --json
```

Use the installation's configured home when it overrides the default. Publication retains an immutable copy and
revision in that project's knowledge, so editing/removing the source Markdown or losing an optional connector does
not change an attempt's pins. This is explicit file-based sharing, not automatic folder/vault crawling or permission
to inspect another project's private store. Scoped shared-folder/graph discovery remains separate optional work.
If retained pinned content is missing/corrupt, fail closed rather than silently substituting mutable files.

## Project Knowledge in the browser

The top bar's **Project knowledge** button opens the current project's canonical knowledge view, separately from
Global Settings → Knowledge (the optional Obsidian connection). It works without Obsidian, embeddings or a model.

- Opening loads bounded metadata and strict own-project curation capabilities, not all document bodies. Documents
  can be filtered by kind, paged or searched explicitly. Search snippets are bounded; narrow a truncated search or
  return to the paged list to continue discovery.
- Selecting a document reads its exact listed revision in 4,096-character slices, with section selection and explicit
  continuations. The view identifies content/revision hashes, kind, tags, sources, publisher and viewer-local time.
  Published revision history permits historical reads; historical text is labeled and never silently replaced with
  current content. Reload to discover a later current revision.
- Proposals have pending/published/rejected lists. Review shows the proposed slice, its exact base comparison and
  base metadata, plus current text when stale. Comparison is bounded, not a claim that a slice represents the full
  document. Continuations include remaining base/current text even when the proposal itself is shorter. A missing
  base/comparison refuses review; a new-document proposal explicitly shows no prior document.
- Publish/reject and user pin/unpin each require a separate explicit confirmation bound to the revisions read.
  A stale proposal cannot be published/rebased; resubmit against the current revision. Strict server permissions
  remain authoritative, including user-only protection of pinned decisions. Failed/uncertain mutations offer only
  a user-triggered exact retry with the retained request id; they are never automatically retried or retargeted to
  another project. Closing/reloading discards the UI draft, not retained server history or receipts.

Markdown uses the installed React Markdown/GFM pipeline with raw HTML disabled. Images never fetch; relative,
same-origin, credential-bearing and unsafe-scheme links are non-navigable. Explicit external HTTP(S) links open
with `noopener noreferrer`. The document cannot embed an active form or call privileged Kanban APIs. Source links
use the same navigation rule. No knowledge body enters the global project summary stream or a shared browser cache.

Project changes unmount the private view, fence late responses and discard selection/confirmation state. Curation
does not change task columns, launch agents, approve execution, adopt task references or alter the optional connector.
New ordinary documents/proposals can still be authored using the scoped CLI; this view is discovery and curation,
not an unbounded document editor.

## Publish, propose and curate

Publication requires an expected current revision. Use `none` only when creating a new id. IDs are lowercase
letters/digits/hyphens; paths, aliases and reserved object keys are rejected. Whole documents are limited to 65,536
characters/262,144 UTF-8 bytes and 128 headings. Source refs identify evidence and authorize no action.

```sh
# User or own-project orchestrator: publish reference material, NOT an execution-plan approval.
kanban knowledge publish api-pagination --project example --kind contract --title 'Pagination API' \
  --summary 'Cursor and error response shape' --file contract.md --expected-revision none --json

# Card/QA/planner: submit a proposal against the revision it actually read.
kanban knowledge propose api-pagination --project example --kind contract --title 'Pagination API' \
  --file proposed-contract.md --expected-revision <current-sha256> --reason 'Clarify the cursor shape' --json

kanban knowledge proposals --project example --json
kanban knowledge proposal <proposal-uuid> --project example --json
kanban knowledge review <proposal-uuid> --project example --decision publish \
  --expected-revision <proposal-base-sha256> --json
kanban knowledge history api-pagination --project example --json
```

Use `--file -` for bounded stdin, not inline shell text. Write commands accept `--request-id <uuid>`; reuse it only
for an exact retry. Its receipt and change commit together. Reusing it for another author/body/action is refused.

Cards may propose but cannot publish/review. The user and the own-project orchestrator curate ordinary documents.
Only the user can pin/unpin or modify/review a user-pinned document:

```sh
kanban knowledge pin api-pagination --project example --expected-revision <current-sha256> --json
kanban knowledge unpin api-pagination --project example --expected-revision <current-sha256> --json
```

Publication cannot clear a user pin; replacing metadata, restoring old content or reviewing a proposal does not
bypass it. There is no delete/alias/supersede endpoint. Other documents may cite a protected decision but cannot
replace its identity or pin. Contradictory prose is not automatically judged by a model: curators must reconcile it,
and the pinned decision stays fixed. Stale proposals cannot be silently rebased; submit a new proposal at the current
revision, or explicitly reject the old one. Pending/reviewed proposals preserve original submitter and reviewer.

## Boundaries and retention

- No operation changes board columns, starts a task, approves/expands a plan, changes a kit/budget or lands code.
- A document of kind `plan` is still reference material; execution approval remains the existing user-only route.
- Content is untrusted reference text, not a higher-priority instruction channel. Never store credentials as knowledge.
- API bodies are excluded from server error telemetry. Keep the same-Unix-user filesystem limitation in mind: scoped
  APIs and private file permissions are not an OS sandbox against arbitrary same-user code.
- Default-kit/manual projects can use knowledge too. No provider, model or external service is required.
- Store ceilings are 500 document ids, 4,000 published revisions, 1,000 proposals, 4,096 write receipts and an 8 MiB
  manifest. Reaching a ceiling refuses new writes; it never evicts history/pins or silently forgets retry receipts.
  Automated archival/GC is not implemented in this slice.

The optional app-level Obsidian connector is separate. Scoped vault/Shared mappings and native graph traversal are
the `obsidian-scoped-graph` roadmap card; publishing knowledge does not grant broad Obsidian access or export a vault.
See `docs/specs/cost-aware-multi-agent-coordination.md` and `docs/fork/obsidian-connector.md`.
