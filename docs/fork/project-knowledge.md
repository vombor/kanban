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
index, not an approved task context or plan approval bundle**. Task-pinned references and automatic stable launch
bootstrap pointers are dependent roadmap work, not claimed by this foundation.

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
