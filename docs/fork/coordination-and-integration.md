# Advisory coordination and speculative integration

These tools use existing native evidence, not an additional supervising model. Neither starts agents, reassigns
cards, creates dependencies, changes requirements/approvals, records per-card QA verdicts or lands work.

Open **Project knowledge → Coordination preview** or **Integration reports** on phone or desktop.

## Coordination preview

`kanban coordination [--project <workspace>] [--plan <plan-task-id>]` returns a bounded JSON report. The default
scope is the current project's non-Done dev cards. A selected plan uses its exact, fully approved retained bundle;
legacy breakdown-only approval, missing content or expansion/bundle mismatch is refused rather than upgraded.
Before expansion, plan members are clearly **planned only**, not runnable cards. After expansion, current native
board links remain authoritative; an old approved dependency graph never replaces edits to those links.

New plan breakdowns may include optional per-card ownership/interface hints:

```json
"coordination": {
  "paths": ["src/api"],
  "produces": ["search-response-v1"],
  "consumes": ["project-identity"],
  "risk": "medium",
  "taskType": "implementation"
}
```

Paths are portable relative file/directory prefixes, not globs. Limits: 20 paths, 10 produced and 10 consumed
interfaces per card. Old breakdowns remain valid; no hint is retroactively inserted into an approved bundle.
Hints are not file permissions, write locks, prerequisites, model assignments or duration estimates.

Reports join native prerequisite status (including missing and Done-deleted prerequisites), current stages/provider
queue/session state, effective models and the existing capacity reader. Other projects' holders are only counted.
**Prerequisites satisfied is not permission to start**: admission, holds, manual choices and existing owners still
decide. Provider-capacity observations are not reservations or promises of immediate availability. One-model/request
capacity, including the selected Lemonade setup, produces sequencing advice without adding a false dependency.

Overlap advice distinguishes reviewed path/interface hints from paths in existing retained snapshots. Preview does
not capture dirty work or change snapshot refs, indexes, HEAD or worktrees. Unsubmitted work, unknown ownership and
unsupported costs/durations remain unknown. Bounds: 100 board tasks / 30 plan members, 100 observed paths per task,
300 displayed dependencies, 200 advice items and 10 details per item. Truncation is labelled; absence of overlap is
never a conflict-free guarantee. No completion forecast or automatic routing is added.

## Exact-candidate integration

```sh
kanban integration preview <task-id> <task-id> [--plan <plan-task-id>] [--project <workspace>]
kanban integration run <task-id> <task-id> --fingerprint <preview-sha256> --request-id <uuid> [--project <workspace>]
kanban integration list [--project <workspace>]
kanban integration read <request-id> [--project <workspace>]
```

If preview used `--plan`, run must select the same plan. Select 2–6 distinct dev cards with existing retained
snapshots, the same exact current base commit, and settled Review according to the shared native settle rule.
Input order is normalized by task id. Missing/unsettled snapshots or damaged pinned contexts are refused; mutable
working-tree text is never substituted. Tasks without immutable context are explicitly labelled unpinned/unknown.

Preview is strictly read-only. It binds exact base/member commit ids, retained task-context revisions (which bind
their spec/knowledge), source evidence, check configuration, selected scripts, bounded source-environment hash and
runtime/checker/build identity. Fingerprints are freshness fences, not evidence of a complete OS/environment sandbox.
Unsubmitted files and unknown external environment changes are not certified.

**Run is a separate user-only mutation**, authorized for the exact preview fingerprint. It executes project install,
setup, tests and teardown code; project scripts are not an OS sandbox. A durable request reservation commits before
creating a candidate or submitting checks. Exact same-id retries return the retained receipt, never another run.
After an uncertain response, retain the id and read/list reports; do not generate a replacement request and replay.

Candidates need Git with `merge-tree --write-tree` support; an unavailable tool reports unavailable, not a fallback
merge. Candidates are combined deterministically in a disposable server-owned bare repository with
fixed internal commit identity/time and no user/system Git config, custom global merge drivers, hooks or fsmonitor.
Source objects are fetched locally; the live branch, source object store, card files/indexes and HEAD are untouched.
A conflict identifies the member where combination failed; no resolution is invented and no checks are run on a
conflicted tree.

Checks reuse the **existing worker's single checks queue**, not a second runner. A ready worker must already exist;
report execution never enables/starts it, bypasses pipeline pause/PID pressure, or changes a project's disabled
checks setting. Alternate worker builds are not used. Unavailable/busy pre-submission admission is reported without
running checks. Configuration/toolchain/environment are rechecked before project code runs. Scripts missing from the
combined candidate, harness failures and incomplete results never count as passing checks.

The ordinary runner retains its environment stripping, redaction, timeouts, process-group handling, install cleanup,
and isolated database setup/teardown. A configured `checks.envFile` is explicitly taken from the registered project's
main checkout, bounded to 1 MiB and hash-pinned; it is never guessed from a member's worktree. The integration database
uses a separate `integration` namespace and unique run id, not any card's database. Raw output, setup commands and
environment values are not returned in integration reports. Teardown remains an explicitly labelled advisory step;
candidate cleanup describes the owned bare repository, not a claim that every external setup side effect vanished.

Integration results never write card checks, objective acceptance, QA logs/verdicts or landing receipts. Even
**checks passed + current** applies only to the exact candidate combination, not to individual QA or permission to
land. Reads recompute freshness; changed evidence is stale, unavailable evidence is unknown, and neither reruns code.

Reports live at `<configured home>/data/<workspace>/integration/reports.json`; completed owned bare candidates are
removed. Unknown execution or cleanup retains its reservation/candidate for operator review, with **no automatic
recovery, replay, release or deletion**. A worker restart does not resubmit it. This initial slice deliberately
requires operator investigation of uncertain runs; it does not guess that an old subprocess stopped. Other ordinary
project work is unaffected by that report hold. Corrupt journals and ceilings (100 reports / 4 MiB) refuse new writes
without eviction/reset. The UI shows the 20 most recent reports; retained ids remain readable through CLI/API.

All reads are strict own-project for agents, including isolation-off and cross-project-grant configurations. Only
the user may run code. Both tools remain report/advice facilities, independent of the existing QA and landing gates.
