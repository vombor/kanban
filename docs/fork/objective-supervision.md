# Native objective supervision and scoped admission

Kanban keeps project-scoped objectives, immutable acceptance requirements, task lineage and retained owner
evidence inside the runtime. This is not a Desktop OpenCode dependency, a new global agent, or another board,
landing, recovery or wake writer.

**Report mode remains the default.** Explicit opt-in enforcement gates new **Kanban-issued agent sessions and
prompts**. It does not kill an active tool, intercept direct user terminal keystrokes/shell commands, meter an
arbitrary CLI's internal model calls, change models, or guarantee spending. Unknown usage/pricing is never zero.
A reported `held` objective means acceptance needs owner evidence or a handoff; it does not mean an ongoing
tool was stopped.

## Inspect in the browser

The project header's **Project objectives** (target icon) opens the current project's objective list. Select an
objective to inspect:

- Runtime status and revision; immutable requirements and their SHA-256.
- The pinned checks/QA/landing acceptance policy, explicit task roots and automatic descendant lineage.
- Owner handoffs and retained exact-snapshot checks, QA verdicts and authoritative final landing commits.
- Observed attempts, reporting reservations, ambiguous delivery/start outcomes and retained usage/price revisions.
- Unknown total cost, partial coverage and any conservative observed subtotal, separately labeled.

The dialog polls reads only while visible. **Recheck retained facts** is a user-requested native collection of
existing evidence. It does not run checks, QA or models, resume tasks, clear guards, raise limits, certify an
agent's claim, or reopen experiments/benchmarks. Read failures are not an empty project or verified completion;
any stale detail remains labeled by its last runtime revision and refresh error. Closing or switching projects
clears private content and ignores late responses.

Long receipt histories show bounded recent entries in the dialog; the full history remains retained and can be
read through the scoped CLI. No losing attempt or superseded pricing revision is deleted to simplify the display.

## Create an objective and configure admission

Use existing dev-task ids belonging to this project's board. Requirements, policy and limits are user-owned;
identified same-project sessions may read, but agents cannot write or approve them. Unknown/cross-project callers
are refused even when isolation is off. Run these commands as the user against the intended runtime/home:

```sh
kanban objective create "Preserve the regression" --project <project-id> \
  --file /path/to/requirements.md --task <dev-task-id> --json
kanban objective list --project <project-id> --json
kanban objective read <objective-id> --project <project-id> --json
kanban objective recheck <objective-id> --project <project-id> --json
kanban objective limits <objective-id> --project <project-id> --revision <current-revision> \
  --attempts 3 --minutes 30 --usd 1 --mode report --json
```

Creation does not start tasks. A requirements document or task reference is never execution approval for a plan,
runoff, model substitution or another experiment. New objectives do not relabel older unbound producer results.
Reporting-limit updates require the current revision; stale updates fail instead of overwriting a user's newer
choice. Use `none` for an individual threshold to clear it. `--request-id <uuid>` allows an **exact** limit-update
retry after an uncertain response; changing the payload under the same id is refused. To opt into supported
Kanban-admission enforcement, add `--mode enforce --acknowledge-admission-scope`. Without the acknowledgement or
a supported runtime, enforcement is refused. `--unknown-cost hold` blocks new admissions when a USD threshold has
incomplete coverage; explicit `allow` keeps the uncertainty visible and is **not** a spending guarantee.

The native dialog also provides creation, revision-checked limits and audited user-only controls. It preserves
draft values on a background revision change rather than overwriting the user's edits; explicit draft rebase
adopts the new revision. Unconfirmed mutations retain an exact retry identity, never retry automatically.

```sh
kanban objective pause <objective-id> --project <project-id> --revision <revision> --reason 'Preserve active work'
kanban objective resume <objective-id> --project <project-id> --revision <revision> --reason 'Admission may proceed'
kanban objective override <objective-id> --project <project-id> --revision <revision> \
  --task <own-task-id> --kind start --reason 'One reviewed admission only'
kanban objective revoke <objective-id> --project <project-id> --revision <revision> \
  --control <unused-override-id> --reason 'Withdraw this unused permission'
kanban objective acknowledge <objective-id> --project <project-id> --revision <revision> \
  --reservation <uncertain-id> --reason 'Inspected retained task/session evidence'
```

Pause blocks future Kanban admissions in either mode, not existing processes. Resume clears that pause; already
queued valid work may proceed through ordinary revalidation, but an uncertain reservation is never replayed.
Overrides permit one next own-task `start` or `input`, are consumed atomically, and are invalidated by changed
limits/requirements. They cannot bypass pause, unresolved uncertainty, provider capacity/quota, guardrails, QA,
landing vetoes, approval or model-assignment policy. Revocation retains the grant/audit; acknowledgement retains
the original uncertain state and conservative charge. Neither produces acceptance or authorizes a benchmark rerun.

## Explicit manual lineage

```sh
kanban objective link <objective-id> --project <project-id> --revision <revision> \
  --parent <own-implementation-task> --task <unstarted-backlog-dev-task> --kind rework
```

Existing links require unstarted own Backlog dev tasks with readable session/pipeline/history evidence. Planned
new ids can be bound before creation with `--planned`. Both are reference/binding operations, not task creation,
start, plan approval or experiment approval. The ordinary runoff creator supports explicit user-owned
`--objective`, `--objective-revision`, `--objective-parent` together and captures lineage **before** group/card
creation; `--from` alone is still just a prompt reference. Exact retries remain safe after planned children appear.

## Evidence and cost meaning

Completion requires authoritative landing plus the landed task's own checks and required QA for the same snapshot
and pinned requirements/policy. A sibling's PASS cannot certify its parent or another racer. A final message,
settled turn, Done move, created replacement or worker assertion alone is insufficient. Reconciliation retains
missing, stale, conflicting and guard-blocked evidence as incomplete rather than manufacturing acceptance.

Usage is collected through the existing CLI token reader for explicit objective member worktrees, including
retained ids after pruning. It does not copy transcript text or tool input. Requests are deduplicated by native
backend identity; copied/resumed history is not charged again merely for appearing in a replacement's worktree.
Missing provider identity, metrics, cache breakdown, time or attempt attribution remain explicit uncertainty.
Delayed/mixed session totals do not become guessed per-request charges, and agent/model defaults are not billing
evidence.

Priced request observations retain the price-table digest and selected rates. The **observed conservative subtotal**
uses the highest retained estimate per source; source disappearance or a later unknown revision cannot credit
back a previously observed amount. It is neither an invoice nor complete cost coverage. The total remains unknown
until comprehensive admitted-attempt/backend/billing coverage is established.

Reservations are recorded just before an accounted start/input, not while provider capacity or a user's
draft holds delivery. Ambiguous starts, output-only delivery proof and interrupted reservations remain uncertain
across restart. They do not authorize replay or kill an active tool. The existing dispatcher, typed-input hold,
checks, QA and landing owners retain their existing safety and user-approval rules.

Covered entry points include ordinary dispatched starts, blank composers/restores, manager auto-restarts through
ordinary dispatch, recovery's pre-stop resume check, automated/held input, manual task-send API, split raw API Enter
and browser-generated review/git prompts. Physical starts and submitted operations are counted conservatively,
including QA/recovery/losing descendants; an observed turn is not double-counted when its native clock matches a
reservation. Empty composer birth/output does not claim a model attempt. No-refund uncertainty and fixed elapsed
deadlines survive restart. Explicit live user keystrokes and internal CLI continuations remain outside the admission
control boundary and can contribute unknown usage; the UI/CLI acknowledgement makes that boundary explicit.

Maintainer tooling and local-pod smoke live separately under `tools/maintainer/`. These objective capabilities ship
in the product, but the maintainer conversation, schedules, credentials and installation artifacts do not.
