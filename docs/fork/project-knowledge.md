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
