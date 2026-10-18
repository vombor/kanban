# Maintainer operations / native objective supervision split

User request: keep the Kanban package maintainer in OpenCode V2 responsible for issue discovery, fixes and local
pod smoke testing; move durable objectives, restart-safe reconciliation, verified completion, actionable handoffs
and explicit attempt/time/cost limits into the shipped Kanban runtime.

## Architecture decision

No new all-project LLM super orchestrator. The existing server and pipeline/watchdog already own instance-level
scheduling and project-scoped effects. Add a deterministic objective/evidence/admission domain to those owners.
Each project's orchestrator retains its own scope. User-visible instance summaries may aggregate counts; private
requirements, evidence, handoffs and costs remain scoped to the project's strict identity, including isolation off.

Maintainer automation is developer/operator tooling outside the npm/image payload. It uses the maintainer's
existing OpenCode V2 conversation and App identity, not a pod project card editing Kanban's own repository. Local
smoke testing owns disposable pods/containers and isolated homes/projects; it must not interrupt the active pod,
reuse its data, rerun benchmarks, launch another browser or change provider/model/credential policy. Browser checks
use owned contexts on the existing shared Chrome sidecar. Updating the active pod remains a separately safeguarded
deployment operation, not an automatic consequence of a maintenance fix or smoke test.

## Native invariants

- Immutable requirement/evidence identities, task/attempt lineage retained after pruning, durable locked writes.
- Reconcile facts from existing session/checks/QA/landing owners; never replay an uncertain turn or add a board,
  verdict, Done, landing, recovery, ATTENTION or wake writer.
- A turn ended / Review / Done column / agent claim alone is not objective completion. Exact snapshot, required
  checks/QA and final commit/landing receipts must agree. Missing/stale evidence remains unknown/blocked.
- Limits are user-owned. Default reporting/backward compatibility, explicit enforcement opt-in. No invented budget
  amounts, provider/model promotion, abrupt tool kills, or guaranteed-spending-cap claim.
- Attempt/time/cost admission shares ordinary starts and automated turn delivery, respects provider queues and typed
  input protections, accounts for concurrent reservations, and retains uncertainty across restart.
- Unknown/delayed/mixed-provider usage is not zero. Preserve usage provenance/de-duplication and price revision,
  include QA/rework/losing attempts, and label incomplete coverage rather than fabricating precise cost.
- Handoffs identify the objective, blocked condition, existing owner and smallest useful user action. User-only
  resume/limit/override controls do not change requirement approval or bypass safety holds.

## Plan

- [x] Inspect the existing roadmap, ownership/admission paths, state/usage readers and maintainer smoke harness.
- [x] Move maintainer tooling/build/tests/docs outside the product payload, preserve installed jobs/receipts/schedule.
- [x] Add independently verified exact committed-export/artifact local-pod smoke gating, durable no-replay reservation and retained proof to new maintainer jobs; installed historical artifact/jobs remain unchanged.
- [x] Add native objective contracts/store/scoped API and CLI with immutable requirements and explicit root-task membership.
- [x] Connect authoritative checks/QA/final-commit receipts and native restart/observed-attempt reconciliation to existing owners, including explicit automatic/manual descendant lineage.
- [x] Add actionable project-scoped handoffs and audited user-only resolution controls without a second watchdog/wake source.
  - [x] Record automatic escalation/runoff lineage before ordinary starts; recover explicit parent/QA links in topological order.
  - [x] Assess the landed descendant using its own exact-snapshot receipts, retaining losing attempts/evidence without mixing cards.
  - [x] Treat guard-refused attempts as interrupted/incomplete; provide scoped owner guidance, user-only retained-fact recheck and revision-checked reporting-limit CLI.
  - [x] Integrate pause/resume, one matching override/revocation and no-refund uncertainty acknowledgement across Kanban-issued admission; the acknowledged boundary excludes direct user input/internal CLI calls and never promises a billing hard cap.
- [x] Add durable attributed observations, truthful unknown/partial cost coverage and explicit opt-in user-owned Kanban-admission limits.
  - [x] Expose canonical reader observations and preserve missing billing/usage/time attribution as uncertainty.
  - [x] Retain per-source usage/price revisions and a conservative observed subtotal; total cost remains unknown/partial.
  - [x] Record report-only durable reservations at dispatched starts and imminent model input, preserving ambiguous outcomes/restart uncertainty.
  - [x] Cover Kanban admission, explicit manual lineage and user-owned uncertainty resolution; report defaults and unsupported/unknown-cost refusals remain tested. Full internal-CLI/billing coverage is explicitly not claimed.
- [x] Add project UI/readouts and container-compatible user-owned configuration/control forms without Desktop OpenCode dependencies.
  - [x] Add the scoped project-header readout for pinned policy/requirements, lineage, owner receipts, attempts/reservations and unknown/partial cost.
  - [x] Fence late project/selection responses; refresh reads only, preserve failed-recheck warnings and expose user-only retained-fact recheck.
  - [x] Add explicit creation, stale-draft-safe limit editing, scope opt-in, audited control/lineage forms and exact mutation retry after admission integration.
- [x] Verify temporary-home regression/chaos/isolation tests, both typechecks, full build/tests and exact committed-export local pod smoke.
- [x] Publish implementation using the App and verify exact-commit CI (`cc6ac1e6`, run 39132300978); reconcile source-only completion and unchanged live/installed boundaries.

## Scope accuracy

This is a multi-slice implementation, not a claim that all five native capabilities already exist. The prior host
maintenance installation remains operational while its developer tooling is separated. Do not rewrite its prior
successful publication records or mark the native work complete on the strength of the old host tests.

## Resume checkpoint

The user resumed this plan with “yep” after a folder-rename interruption. Only the display name is now `pawsome`;
the physical checkout and workspace identity remain `/projects/foo` / `foo`, with no compatibility symlink. Do not
repeat or undo that operation, and do not resume any unrelated benchmark or model trial.

Supervision changes are UNCOMMITTED in the original host checkout on `fork/stack`. The producer checkpoint started
at `f6660edc`; scheduled issue-only maintenance subsequently advanced HEAD to `4ebad3a8` (see interruption below).
No new agent/session was created and the active pod was not upgraded/restarted for this plan. The installed host
maintainer timer/config/private immutable bundle remain untouched and its journal has no admitted maintenance job.

Completed groundwork:

- Maintainer sources/tests/build/docs moved to `tools/maintainer/`. Product `package.json` exposes only `kanban`,
  `scripts/build.mjs` builds only product CLI/library, root Vitest excludes maintainer tests; separate
  `maintainer:build|test|typecheck` commands work. `npm pack --dry-run` confirmed no maintainer files in the payload.
- Native `src/core/objective-contract.ts`, `src/objectives/objective-store.ts`, strict objective API, tRPC routes
  and `kanban objective create|list|read` are working. Requirements hash objects commit durably before the manifest;
  idempotent request receipts, stale revisions, root task membership, strict own-project reads and user-only writes
  are tested. All cost coverage begins unknown, never $0. Enforce mode is explicitly refused until admission hooks
  are implemented; do NOT claim limits are already enforced.
- `tools/maintainer/local-pod-smoke.mjs` creates a labelled disposable pod with network none and explicit auto-update
  disable; only read-only product dist/package overlays, no live homes/projects/credentials/browser. It exercised
  native objective CLI/API, product setup, UID 1000, PTY and IPv4/IPv6 HTTP/WS. The successful tested CLI bundle hash
  was `864c10c3ad40ddeb02641e71e6390ff5388b8093459c1683b079cd71ec15d6ea` over a cached immutable base image
  `8559549b2ccd44df6d829f4266084bb67efa64902ce8f428badb2148e4340f2d`. No smoke pods remained afterwards.
  The harness now prints PASS only after verified label-owned cleanup; this still needs independent maintainer-job
  completion integration, not merely a worker-authored smoke claim.
- Baseline after the split: 2,937 product runtime/integration tests, 722 UI tests, 27 separate maintainer tests plus
  seven Python cases, both product typechecks, maintainer typecheck/build, and production build passed. One old
  unused-import warning in pipeline/rework-limits.test.ts was left alone.

Initial resumed evidence-store slice (subsequently connected by the producer slice below):

- Added `src/core/objective-evidence.ts` with strict requirement/policy-bound checks/QA/landing facts.
- Added `objective-identity.ts` and `objective-assessment.ts`, and store `binding` / `record` methods with evidence
  idempotency/conflict checks. Assessment requires exact-snapshot project checks, QA PASS when required and a land
  commit; mismatched requirement/policy or newer different snapshots cannot complete it. No agent-facing API accepts
  owner evidence. Twelve objective tests and root typecheck passed after this change.
- At this checkpoint evidence was not yet generated by checks/QA/landing owners. See the next checkpoint for the
  completed producer/observation wiring; admission, cost coverage, handoff resolution and UI still remain pending.

The next producer/observation slice below completed requirement bindings at producer START, exact final landing
snapshot/commit collection and native observed attempts/restart reconciliation. A created-after-run objective must
never adopt old unbound QA/checks as acceptance. Extended lineage, handoff resolution, central opt-in admission,
truthful usage/cost coverage and UI remain next. Reuse the provider dispatcher and typed-input hold; never bypass a
user's draft.

The producer slice unified the `record`/create/update/observation writer's 16 MiB bound, preserving rather than
resetting corrupt state, and added source-producer/restart-replay tests. `objectiveDigest` remains in its separate
identity module. Do not ship partial capability as full supervision.

## Producer / native observation checkpoint

Implemented in the same uncommitted host checkout:

- `submission-stage.ts` captures objective requirements/policy before checks enqueue; `ChecksRequest` carries that
  binding. `worker.ts` retains the exact result receipt in pipeline state before collecting it into the objective.
  Existing checked snapshots are NOT rerun or relabelled just because an objective was attached later. Missing,
  skipped, advisory or harness-only steps do not become passing required checks.
- `qa-gate.ts` pins the binding when creating an ordinary QA card, appends quoted objective requirements after the
  unchanged legacy skeleton, retains the ruled verdict receipt with the existing verdict write, and records explicit
  parent/QA membership before queued QA starts. Evidence-only reassessment remains excluded. QA lineage and receipts
  can be collected from their durable owner state after a crash; historical unbound reviews are never adopted.
- `task-landing-gate.ts` captures the binding before its ordinary guarded land, then retains the ACTUAL pre-land
  snapshot and returned final commit before Done/pruning. No new landing, Done, verdict or board writer was added.
  A crash between git landing and the receipt write remains missing evidence, not a fabricated recovered receipt.
- `server/objective-reconciler.ts` observes all managed projects independently of pipeline/watchdog settings and
  Desktop OpenCode. It collects only retained producer receipts and observes actual session summary transitions plus
  a sweep. It cannot start, resume, nudge, kill or replay work. It uses the existing Review settle clock, ignores an
  explicitly unsubmitted composer and pre-requirement turns, preserves unknown/interrupted attempts across restart,
  and excludes downtime from an interrupted attempt's observed end. QA attempts are attributed through explicit
  membership. Attempts are observational, NOT comprehensive admission reservations or a spending guarantee.
- Objective collection/reconciliation refuses damaged pinned requirements and storage directories; list reads check
  requirement integrity. New/different snapshots or newer attempts cannot retain an old completion. Handoffs point to
  checks/QA/landing/recovery owners, but user resolution/admission controls are not yet implemented.

Final validation at this checkpoint: `npm run check` passed 2,953 product tests plus both typechecks; production
build, 722 UI tests and 27 separate maintainer tests passed. The final guard changes also refuse pre-requirement
timestamps and conflicting same-clock receipts rather than choosing PASS by insertion order. The product bundle
was rebuilt after all source edits. Owned overlay-pod smoke passed with no provider turns, live data mounts,
browser launch or active-pod restart; cleanup was verified. Final tested CLI SHA-256:
`f37f24ab24fcf3aef161536c381f6db90c6e80c5041af8110a23cd71f5790320`, over the cached immutable image listed above.
`npm pack --dry-run --ignore-scripts` retained only the product (27 files, no maintainer source/binary/bridge).
This is not exact-commit publication proof and does not yet gate scheduled maintainer completion. The old unused
import warning in rework-limits.test.ts remains untouched. No commit, push, installed artifact update or release was
performed, and the remaining plan checkboxes accurately remain pending.

Pending next: automatic rework/escalation/runoff lineage and retained per-attempt attribution, user-owned handoff
resolution (without pretending it resumes/stops work before guards exist), central provider-dispatch/automated-input
admission reservations, durable usage/price coverage and explicit enforcement opt-in, project UI, independent
exact-commit maintainer smoke-completion gating, and final full verification/publication. `mode: enforce` remains
refused. No timers, installation artifacts, credentials, providers/models, benchmarks or active pod were changed.

## Scheduled maintenance interruption (2026-10-18)

The user's “Go” resumed extended lineage/handoffs, but the scheduled job
`maint-d3c673b3d2fc44458c5d7037d6a0efff` then restricted immediate work to issues #66/#67. No extended-lineage code
was changed before that interruption. The original supervision plan remains pending; do not treat the maintenance
fixes as completion of its admission/cost/UI capabilities.

Issue-only commit `4ebad3a82c9317609df2e2fe76961a8bdd72b9a7` was authored/pushed as the Kanban App on `fork/stack`.
It contains only refusal observability/automation holds and fresh-board conditional-wake checks plus regressions;
the objectives, evidence store/producer wiring, maintainer relocation and package/build changes remain unstaged.
QA-gate and test-helper edits were staged surgically to exclude the objective changes in those same files.

Exact staged-tree export `1c70e73daee8056bc2e06bfe3cbad0c0465a8303` passed 2,961 tests, both typechecks, 722 UI
tests and production build. Owned read-only overlay-pod smoke passed for that export on the existing cached image;
CLI SHA-256 `a98ec45cad5957e106c8ac0e48d3a38d2d80f33bc67f3cfacc5ac07ccfcfd037`. Its pod cleanup was verified, with
no provider turns, live data mounts or browser launch. This export deliberately retains the previously committed
maintainer packaging, rather than publishing the unfinished split.

Required exact-commit `image.yml` run: https://github.com/vombor/kanban/actions/runs/39118268216 passed for
`4ebad3a82c9317609df2e2fe76961a8bdd72b9a7`. Original issue bodies/labels/comments were rechecked against the admitted
material hashes, then App-authored SHA/job-linked resolution comments were posted and #67/#66 closed:
https://github.com/vombor/kanban/issues/67#issuecomment-6248679349 and
https://github.com/vombor/kanban/issues/66#issuecomment-6248679730 . The installed supervisor's own read-only evidence
bridge independently verified both closures, unchanged acceptance, commit ancestry/push and exact-SHA CI; its
journal records this scoped job `completed`, with verification digest
`24373210dd5b9c062f3b8c6e7bdf1fa950d4a3999ac9c47ee85b3efd98c94425`. The atomic 0600 worker result accounts for
each assigned issue exactly once; that report alone was never treated as acceptance. No release, deployment, live restart,
benchmark rerun/reclassification, credential/provider/model change or additional agent/session was performed.
The installed supervisor retains its original admitted job/history and existing schedule; no admission was replayed.
Its scoped result/proof receipt is complete. Extended lineage, handoffs, admission/cost coverage, UI and maintainer
smoke-completion gating remain the pending supervision work; no native enforcement was enabled by these fixes.

## Resumed lineage / handoff reporting slice (2026-10-18)

The user resumed with “keep going” after the scoped maintenance job completed. Work remains uncommitted on top of
`4ebad3a8`; no new release, active-pod update, extra agent/session, credential/provider/model change or benchmark
execution was authorized or performed.

Implemented:

- Generalized the in-process owner attachment from QA-only to explicit `qa` / `escalation` / `runoff` links. The
  existing rework owner captures pinned requirements/policy BEFORE creating a sibling, commits that link alongside
  its sibling state, collects objective membership, then uses the ordinary guarded start. Existing approval/routing
  and preserve-tag decisions are unchanged. Same-card reworks remain attempts, not fabricated sibling cards.
- Task graphs validate unique membership, real non-QA implementation parents and acyclic rooted lineage; objective
  state also refuses duplicate ownership/identities/receipts without resetting or evicting history. Restart replay
  processes retained parents before descendants/QA regardless of insertion order. Old unbound siblings are not
  adopted by title/prompt similarity or a later objective.
- Completion may use an explicitly bound landed replacement, but requires that replacement's own checks and QA on
  the actual landed snapshot. Merely creating a sibling/racer or writing PASS never completes the root; conflicting
  simultaneous land receipts remain unknown, newer work invalidates an old completion, and losing evidence is kept.
- Native observation reads the maintenance fix's execution-blocked marker and retains that turn as interrupted with
  an explicit user handoff, never settled acceptance. It neither restarts nor retries the turn.
- `objective read` returns scoped owner guidance and argv-form read/recheck/pipeline-status commands. User-only
  `objective recheck` waits for current observation work, then collects only that project's retained owner facts;
  unavailable/corrupt storage is an error, not a successful refresh. Recheck executes no checks, QA, model turn,
  task resume or guard override and never clears missing/stale evidence by assertion.
- `objective limits <id> --revision <n> [--attempts N|none] [--minutes N|none] [--usd N|none]` plus `--unknown-cost`
  and exact-retry `--request-id` expose the existing user-owned, revision-checked reporting settings. Enforce mode
  remains explicitly refused. These thresholds are NOT operational admission limits or a spending guarantee.

Final validation for this slice: 2,969 product tests, both typechecks, production build, 722 UI tests and 27 separate
maintainer tests passed. Extended owned-pod smoke passed native guidance/recheck, report-limit saving, unchanged
pinned requirements/unknown cost, no model attempts and enforce-mode refusal. Its cleanup was ownership-verified;
no live data mounts, provider turns or browser launch. Tested CLI SHA-256:
`49cd5ea1724eeb20341a989ec4ebd2c8770a282002a8aa4c9d9de1e493f9313c`, over the cached immutable image listed above.

The first extended smoke found that a newly registered project can have objectives before its terminal owner is
loaded. The scoped recheck now collects durable owners without activating/trusting an agent workspace; it uses a
partial (not complete) session observation when no live owner exists, so missing live-session information does not
settle or erase retained running attempts. A dedicated regression and a second owned-pod smoke passed this path.
The original failed smoke also cleaned up its owned pod. The probe module is explicitly ignored by the existing
Biome configuration; its syntax check passed and the native cases were exercised against the actual bundle.

Remaining: manual CLI runoff/explicit-user lineage where a reference is not execution approval, comprehensive
per-attempt usage attribution/price coverage, durable admission reservations across ordinary starts and automated
input, safe user pause/resume/override controls, native project UI, independently verified exact-commit maintainer
smoke-completion gating, final chaos/regression verification and scoped publication. No main pending checkbox is
claimed complete merely because these reporting controls exist.

## Usage / report-reservation slice (2026-10-18)

The user continued the original plan. New changes remain uncommitted and undeployed on top of `4ebad3a8`; no extra
agent/session, live-pod operation, benchmark execution, provider/model assignment or credential mutation occurred.

- Extended the existing token reader with opt-in structured observations while leaving board totals/model output
  unchanged. Claude keeps last usage per message id; Cline keeps per-message actual `modelInfo.provider` (verified
  against installed @cline/shared message types) and inclusive-cache normalization; Codex observations retain native
  session identity/total-change/time context; Copilot's delayed/mixed session totals stay unattributed uncertainty.
  No transcript text/tool input is copied into the ledger and source keys are hashed. Missing metrics, identity,
  provider, cache breakdown or timing are not zero; model/agent defaults are never substituted for billing evidence.
- The native collector shares the instance's existing reader and scans only explicit objective members' canonical
  current/approved-legacy worktree candidates, including retained ids after pruning, never the main checkout. It
  captures known request/attempt attribution and price-table digest plus selected rates. AWS-derived prices are not
  applied to another billing provider. Unknown attribution or mixed/session totals are not priced as free.
- Usage revisions append durably under the objective lock, rather than adding cumulative rereads to spend. A copied
  request's backend identity is charged once per objective across its members. Historical priced versions remain;
  disappearing sources or later uncertainty cannot silently credit them back. `observedEstimatedUsd` is a
  conservative highest-retained-estimate subtotal, NOT complete cost. `estimatedUsd` remains null, coverage at most
  partial until comprehensive admitted-attempt/backend/billing coverage is proven. No guaranteed-spending-cap claim.
- Durable admission receipts contain only own task/requirement identity, operation, time, outcome and report reasons,
  never prompts or credentials. Concurrent exact identities serialize; completed/ambiguous duplicates are not
  replayed. Pre-server-start reserved outcomes become uncertain, not released or automatically retried. Ordinary
  dispatched starts record before execution, preserving provider validity/capacity and its unforgeable WeakMap
  authorization; live reuse and blank composers are not counted as new launches. Input accounting sits at imminent
  delivery, after provider/draft checks; clear/blank/non-Enter controls are excluded. Known non-delivery releases its
  receipt, while output-only proof, errors and aborts retain uncertainty. Existing provider queues and typed-input
  protections remain their owners; no draft is overwritten and no active tool/model is killed.
- These are REPORTING thresholds/reservations, not complete execution enforcement. Enforce-mode API requests remain
  refused; hand-edited unsupported enforce state cannot authorize a recorded objective start. Missing or partial
  cost data stays unknown. Manual runoff/reference lineage, all restart/delivery reconciliation edges, full usage
  completeness, safe user resume/override, UI and maintainer exact-commit smoke gating remain pending.

Final validation checkpoint: 2,976 product tests and both typechecks passed; production build, 722 UI tests and 27
maintainer tests passed. Updated owned-pod smoke passed after fixing a fresh-project registry lookup: usage resolves
the scoped path from the read-only registered-project index if no activated registry entry exists, without loading
or trusting an agent workspace. Its regression passed. Tested CLI SHA-256
`c84f967d10d9bafd7dff2bd9e82706b08f137cf6c0333472f4d556117e07c945`; cleanup was verified, no provider turns,
live data or browser launch. The earlier failed smoke cleaned up as well. No native publication or installation
artifact update occurred. The pre-existing rework-limits import warning remains untouched.

The coding server restarted during the following UI work. The same conversation resumes from this checkpoint;
the source, completed issue fixes, passing usage/reservation checks and owned-pod smoke must not be replayed.

## Native objective readout slice (2026-10-18)

Added a project-header Objectives entry and project-scoped dialog. It renders native runtime status/revision,
pinned policy and immutable plain-text requirements/hash, explicit task lineage, owner handoff, authoritative
checks/QA/landing receipts, observed attempts/reservations and uncertainty, retained usage/price revisions and
qualified final commits. Receipt lists are display-bounded without evicting history. The dialog never derives
completion from agent claims or board columns. Unknown total cost and conservative observed subtotal are separate;
tiny positive estimates do not round to free. Report-only/unavailable enforcement is explicit.

The async hook has separate list/detail request generations and a project/unmount fence. Pagination preserves
selected evidence. Polls only read; a user click invokes the native retained-fact recheck without replaying work.
Failed recheck warnings survive a successful list reload, and failed detail refresh labels the retained response
as stale rather than hiding uncertainty. No broad client cache/project-summary stream carries objective text.
App closes/unmounts this dialog at project-switch start. Tests also exercise scope changes without the App key.

Eleven UI regression tests pass, including late old-project detail/recheck replies, same-project selection races,
unmount cleanup, unreadable-list versus empty-project handling, plain-text HTML-like requirements, pagination,
read-only refresh, failed recheck preservation and tiny-cost coverage. Full checks pass: 2,976 product tests,
733 UI tests, both typechecks and production build. The pre-existing rework-limits unused-import warning remains
untouched. The product-only npm dry-run reports 27 payload files with the built objective UI and no maintainer
code. Owned overlay pod smoke passed again for CLI SHA-256
`c84f967d10d9bafd7dff2bd9e82706b08f137cf6c0333472f4d556117e07c945`, with verified cleanup, no live data/provider
turns/browser launch. This remains an isolated cached-image overlay test, not a new published image or deployment.
Shared-Chrome phone and desktop scenarios passed in separate completed runs (13.6 s and 15.3 s respectively),
including requirements retention after restarting their own disposable runtimes, unknown cost, escaped plain-text
requirements, no fabricated acceptance and no objective attempts/reservations created by UI recheck. The earlier
combined runs passed phone but reached the shell's 120 s limit before a desktop receipt; they are not counted as
successful combined-suite runs. No root cause is inferred from that timeout. Follow-up checks found no matching
test processes and no remaining `kanban-mobile-e2e-*` directories under `/tmp/opencode`. Browser runs used only
owned shared-Chrome contexts and fake selected CLIs. No Chrome/default-context or live runtime operation occurred.
Docs: `docs/fork/objective-supervision.md`.

Remaining controls are NOT implemented by these readouts. No live-pod update/restart, maintainer artifact/schedule
change, provider turn, benchmark reopening, release or commit/push is authorized or performed by this slice.

Next integration boundary: manual runoff creation is `src/commands/bench-runoff.ts`. Its group is recorded before
card creation, and explicit `--start` is separate. Objective lineage must be a separately validated user-owned
binding before creation/start, never inferred from a prompt source, historical benchmark, title similarity or an
ordinary reference. Comprehensive admission/uncertainty resolution and independent exact-commit maintainer smoke
gating remain pending; those investigations do not authorize executing a runoff or changing installed tooling.

## User-authorized five-step completion (2026-10-18)

The user explicitly requested all five next steps, including source publication. Scope is App-authenticated
commit/push and exact-commit verification, not a release, live deployment, installed-artifact/schedule change,
provider/model/credential change, benchmark reopening or new agent/session. Keep report mode as the default.

- [x] Add revision-checked explicit/manual lineage before user-created tasks/runoffs can execute; references alone never approve work.
- [x] Close Kanban admission gaps, including manager auto-restarts, blank-session starts, raw API submissions, browser-generated prompts and pre-stop resume guards; retain uncertainty across restart.
- [x] Add user-only pause/resume, bounded one-admission override/revocation and no-refund uncertainty acknowledgement with audit/retry receipts; opt-in enforcement labels its Kanban-admission scope, never an internal-CLI/billing hard cap.
- [x] Implement independent exact committed-export/artifact smoke gating and durable smoke reservations/receipts; historical jobs/results stay compatible and no installed tooling is replaced.
- [x] Add native configuration/control UI, full regressions/typechecks/build/owned smoke, then scoped App-authenticated implementation commit/push and exact-commit CI verification.

Admission controls must gate new server-issued work before stopping/replacing any session. They never kill an
active tool or claim visibility into an arbitrary CLI's internal model requests. Explicit user's live terminal
keystrokes are not automated prompts; cost coverage remains unknown/partial and unknown-cost enforcement needs
the user's explicit policy. Any supported enforcement UI must describe these boundaries rather than promise a
guaranteed spending cap. Recheck/control/lineage records are not approval for a plan, experiment or benchmark.

Historical readout reconciliation (before the five-step authorization): implementation, documentation, eleven privacy/refresh/cost UI regressions, full
checks/build, product payload boundary and owned runtime/browser smoke are complete for this slice. The combined
browser-run timeout is a retained testing limitation, not a claim of full mobile-suite success. All broader
lineage/admission/enforcement/control/edit-form/maintainer-gating/publication work was then pending. The completion
checkpoint below supersedes that work status, without changing historical benchmark or maintenance verdicts.

## Five-step implementation and performance completion checkpoint

The user additionally authorized one delegated file-changes investigation. Its measured eager diff/Prism work was
optimized without truncating content or modifying terminal output behavior. Owned 100-file/2,400-line shared-Chrome
fixtures measured ~2,670.5 ms before, 47.2 ms phone / 56.8 ms desktop after; initial rows 800 → 32/40 and parent-only
updates 66.6 ms → <0.1/0.1 ms. Navigation to distant files, comments/export, context expansion/revisit and split view
passed. Visited bodies remain mounted, so this is not a strict final DOM cap or attribution of the whole live app.

Implemented native explicit/manual lineage, complete Kanban-issued admission guards, audited pause/resume/one-shot
override/revocation and no-refund uncertainty acknowledgement, report defaults/explicit scope acknowledgement,
unknown-cost policy, stale-draft-safe native configuration forms and exact mutation retries. First blank composer
birth is unsubmitted; native submit facts supply its attempt clock. Browser-generated review/git prompts use the
same verified server owner, not a viewer WebSocket bypass. No policy/QA/landing/benchmark approval is synthesized.

New maintainer jobs have independent exact committed-export/artifact smoke, locked reservation before mutation,
immutable retained proof and fresh post-smoke App issue/CI readback. Unknown execution/cleanup never replays the
owned mutation. Missing immutable-image configuration refuses admission before a model turn. Historical jobs,
installed artifacts/configuration, reservations and 03:00 America/Los_Angeles schedule are unchanged.

Validation: 2,989 product tests, 751 UI tests and 33 separate maintainer tests pass; both product/UI and maintainer
typechecks, both builds, formatting and diff-whitespace checks pass. Native controls pass separate shared-Chrome
phone (17.6 s) / desktop (19.2 s) cases, including refused paused CLI start, resume eligibility and retained data
after their own runtime restart, without an objective attempt or reservation. Product npm dry-run has 27 files,
no maintainer payload. Expanded owned overlay smoke passed for CLI SHA-256
`10c65be9369cd87f5db09c67c19d3efd7e41d77324dcfed8554e51cadb394478` over immutable cached image
`8559549b2ccd44df6d829f4266084bb67efa64902ce8f428badb2148e4340f2d`: explicit opt-in, unknown-cost hold,
pause/resume/no fake acceptance and cleanup verified; no live mounts, provider turns or browser launch.

All five requested implementation/publication steps are complete for the documented Kanban-admission boundary.
Implementation commit `cc6ac1e65bac82090ba9466d76c61adb11f78e8c` was App-authored/pushed to `fork/stack`;
App readback confirmed remote SHA and exact push-event/repository/branch CI success at
https://github.com/vombor/kanban/actions/runs/39132300978. Product build/tests, separate maintainer tooling, bare
non-root image smoke and validated dev-image publication all passed. No release tag/npm release or live deployment
was performed. The active pod remains on its previously authorized build; private installation tooling, schedules,
provider/credential settings and archived benchmark outcomes were not changed.

The exact committed export passed independent installs/build, maintainer typechecks/tests and expanded owned pod
smoke. CLI SHA-256 `10c65be9369cd87f5db09c67c19d3efd7e41d77324dcfed8554e51cadb394478`; full product artifact-tree
SHA-256 `33ed2aac43de39a8c152395b3305ee59ae09dac82bd97f2096e3f565cc1e94f6`; both export and pod cleanup verified.
The first export attempt correctly refused an omitted root test-config change before any build/pod operation;
the unpublished own commit was amended to include it, not by discarding user work. Secret guard scanned the
implementation commit clean.

Performance cleanup correction: the first timed-out delegated baseline left one scratch root behind despite its
initial report. The delegate confirmed that exact root by its own fake CLI/config, vanished recorded PID and
matching timeout artifact, checked there were no active users, and removed only that owned root. No live resources
were modified. Separate profile passes, rather than timed-out combined runs, are the browser verification evidence.

Full CLI-internal/billing measurement and the broader knowledge roadmap remain explicitly outside this finished
admission boundary, not silently priced at zero. Activation on the live installation and installing/configuring
the new immutable maintainer artifact require their own user authorization. This follow-up completion record is
documentation-only; the exact implementation test/publication receipt remains the commit/run above.
