# Kanban package maintainer operations

This is **developer/operator tooling**, separate from the shipped Kanban package's runtime, board, QA, landing,
issue-import and recovery owners. The maintainer uses OpenCode V2 to discover issues, implement fixes and smoke
test an isolated local pod. This is not a pod project card editing Kanban's own repository. Build with
`npm run maintainer:build`; run regressions with `npm run maintainer:test` and `npm run maintainer:typecheck`.
The runtime's native project objective supervision is separate and has no Desktop OpenCode dependency.

## Boundary

The operator supplies a private configuration, an explicit host-only Kanban home and an **existing** OpenCode V2
session. The tool never creates sessions, changes models, interrupts active work, retries an admission POST,
releases held work, publishes releases or updates/restarts the live instance. It refuses container/card contexts.
The worker prompt retains the installation's separately granted scoped fix/test/commit/push/issue-closure authority;
issue descriptions and comments never grant additional authority. GitHub reads use an operator-selected App-only
bridge, not ambient PATs. App keys/tokens are not stored in the config, job journal, prompts, reports or command args.

This is **not an OS sandbox**: host agents running as the operator share that user's file access. Private file modes
and container-context refusal prevent accidental access/launch, not a malicious same-UID process. Independent GitHub
verification rejects unsupported result claims; it does not prove semantic correctness or replace project QA.

## Configuration

Owner-written JSON (no group/other write permission; keep it outside project worktrees):

```json
{
  "version": 1,
  "repository": "owner/repository",
  "projectDirectory": "/absolute/checkout",
  "branch": "main",
  "sessionId": "ses_existing",
  "opencodeCli": "/absolute/desktop-v2/opencode-cli",
  "githubBridge": {
    "executable": "/usr/bin/python3",
    "args": ["/absolute/maintainer-artifact/github-app-bridge.py", "/absolute/operator/app-helper.py", "operator-broker-container"]
  },
  "timezone": "America/Los_Angeles",
  "requiredWorkflows": ["checks.yml"],
  "maxJobHours": 24,
  "maxJobs": 500
}
```

The maintainer-only Python bridge uses the existing operator App helper contract (`REPOSITORY`, `BROKER`, `clean_env`,
`run_gh`) and its container-side signing boundary. It checks the pinned repository and supported helper shape,
requests only Contents/Issues/Actions **read** permissions and returns hashes/boolean evidence/public URLs—never
credentials or issue text. An unavailable helper/App permission blocks the check, without fallback. Python 3 and
the operator's existing Podman/GitHub CLI bridge are host prerequisites. Other installations can provide a bridge
implementing the narrow JSON stdin/stdout contract in `tools/maintainer/src/adapters.ts`; no credentials are bundled.

The configured V2 CLI uses its normal service discovery and authentication. A GUI launcher is not a CLI. A CLI
upgrade/path or policy/configuration change while a job is active holds that job for operator review, not retargeting.

## Operations

```sh
node tools/maintainer/dist/maintenance.mjs --home /absolute/host-maintenance-home --config /absolute/maintenance.json preflight
node tools/maintainer/dist/maintenance.mjs --home /absolute/host-maintenance-home --config /absolute/maintenance.json daily
node tools/maintainer/dist/maintenance.mjs --home /absolute/host-maintenance-home --config /absolute/maintenance.json reconcile
node tools/maintainer/dist/maintenance.mjs --home /absolute/host-maintenance-home --config /absolute/maintenance.json status
```

Create the explicit home first. `preflight` reads App issue metadata, the target session, branch/HEAD and journal;
it never queues a prompt or writes a job. `daily` performs one check per local calendar day. Empty issue lists cause
no model turn or session call. Run `reconcile` periodically (for example every ten minutes); it polls only admitted
jobs, never sends agent input. `status` reads local journal data only. `--json` gives bounded structured summaries.
No pending jobs means reconciliation makes no GitHub/OpenCode calls. Existing work is queued, not interrupted.

Journal: `<explicit-home>/data/host-maintenance/journal.json`; worker evidence:
`jobs/<job-id>/progress.json`, `result.json` and immutable hash-named completion proofs. The journal commits jobs,
daily receipts and state transitions together under one heartbeat lock using fsync-before-rename and directory
fsync. Its size/history ceilings refuse new work rather than evict history. Corrupt/empty/symlink journals are
refused, never silently reset. Result/observation errors emit fixed codes, not raw content or provider responses.

## Lifecycle and completion

1. Snapshot issue title/body/author/labels plus **all** comment identities/hashes; pin local starting commit,
   config/target hash and exact prompt id. No raw issue text is persisted by the supervisor.
2. Persist `submitting` **before** the queue POST. A timeout, killed process or receipt mismatch retains its
   reservation. A restart uses inbox and exact-input delivery observations; it never replays the mutation.
3. Observe queued/running/awaiting-evidence/blocked states. Assistant errors count only while this job is the latest
   user input; unrelated conversation turns are not job results. Worker progress is explicitly labelled advisory.
4. Worker writes its strict result contract, covering every assigned issue exactly once. A final chat reply alone
   cannot complete a job. A result is pinned once independent verification begins; replacement requires review.
5. Verify unchanged acceptance evidence, closed assigned issues and this job's App-authored commit-linked resolution
   comments. New human/other-job comments or edited/deleted originals invalidate the old material snapshot.
6. Verify each reported commit descends from the starting commit, is contained on the configured remote branch,
   and has successful exact-SHA, same-repository/branch **push** runs for every required workflow. Missing/pending CI
    waits; failed CI blocks. Preserve the checked issue/commit/CI receipt before committing `completed`.
7. New admitted jobs also require independently executed **exact-commit local-pod smoke**, not a worker's claimed
   pass/digest. Configure `localSmoke: { "imageId": "<64-hex locally inspected immutable image id>" }` explicitly
   when installing this maintainer artifact. No mutable tag, image pull, live mount or provider turn is allowed.
   Admission preflight refuses missing/unavailable image configuration before queuing any new model turn (an empty
   issue list still returns no work without a session call). The host verifies clean HEAD/branch and reported fix membership, rebuilds product outputs with an isolated HOME
   and no inherited credentials, hashes the entire artifact tree, runs its owned overlay pod with verified cleanup,
   then checks source and all artifact bytes again. CLI-only proof cannot substitute for changed/untested UI bytes.
   The local-smoke SHA must also have independent pushed ancestry and exact-SHA CI. Dirty/unavailable/configuration
   evidence holds rather than resetting user work. Existing completed jobs/proofs are not relabelled.

The smoke scope is an exact-source **local overlay** on an immutable cached image, not verification that a new
full image was published/deployed or permission to restart the live pod. Missing operator image configuration
blocks completion of new jobs, not permission to guess. Updating this source does not replace the installation's
immutable artifact, private configuration or 03:00 America/Los_Angeles schedule.

No step creates QA acceptance or treats pricing/provider/model history as permission. Issue closure is not by itself
completion proof. GitHub read-back can establish provenance/CI/closure, not that a fix satisfies every semantic
requirement; worker checks and the project's independent review policy still own that.

## Handoffs and migration

Uncertain, blocked and overdue jobs retain their admission reservation so a queued old prompt cannot execute beside
a replacement. The fixed deadline is measured from initial admission, not renewed by restarts. Automated reads stop
after it; report the job, pinned commit/issues/input id and reason to the operator. **This first slice holds for a
human handoff; it does not automatically resume, switch models or launch a replacement session.** Keep the original
job/evidence/history intact. Do not edit/delete a journal to force retry. A future explicit handoff/reauthorization
protocol is separate work; unresolved jobs intentionally prevent another daily admission.

When replacing a legacy checker, retain its script and receipts. Before enabling the new checker verify that no
old queued/running/uncertain maintenance prompt remains. Only a verified no-work receipt may be copied as a no-work
check; never translate “queued”, “assistant done” or a closed issue into verified completion. The native target
preflight refuses recognized legacy maintenance inbox entries. Use a systemd drop-in/installation-only wrapper
and retain the existing daily timezone; add a reconciliation timer without adding a second admission owner.

Offline regressions include a real SIGKILL at admission, concurrent checkers, lost acknowledgements, stale/changed
results, original-comment edits/deletions, cross-job resolution claims, wrong-SHA/fork/branch CI, unknown evidence,
expired jobs, corrupt state and secret-bearing fake provider responses. All use temporary homes/fake GitHub; no
test runs the live broker, real agent or pod restart.
