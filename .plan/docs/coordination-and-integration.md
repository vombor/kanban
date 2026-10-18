# Advisory coordination and exact-candidate integration

User authorized the next two stages (2026-10-18): coordination preview first, then integration reports. Preserve the
deployed discovery/efficiency work, user-selected three-model Lemonade lineup and one-model concurrency. No new
supervising model, model experiments, secret migration, automatic starts/assignments/dependency edits, or QA/landing
authority. Finer-grained measurement and forecasting are deferred.

- [x] Add optional bounded ownership/interface hints to the existing immutable plan-breakdown format; old plans remain valid.
- [x] Build strict-own-project read-only coordination reports over approved bundles, native prerequisites, retained
  snapshot paths, sessions/stages and provider capacity. Explain possible sequencing without inventing dependencies,
  granting start permission or estimating unsupported completion times.
- [x] Add coordination UI/CLI with late-response scope fences and explicit advisory/unknown states.
- [x] Add explicitly requested exact-candidate integration: immutable base/snapshot/context/checks/toolchain identity,
  deterministic disposable combination, conflicts without resolutions, existing check runner/environment protections,
  bounded durable reports and stale invalidation. Never alter card indexes/worktrees/branches or record QA PASS.
- [x] Add integration UI/CLI with user-only execution, no automatic replay on uncertain submission and read-only reports.
- [x] Validate privacy, immutable identities, prerequisite/hold/capacity truth, merge/staleness/cleanup, redaction and
  phone/desktop flows using disposable fixtures/fake CLIs only; run full source checks.
- [ ] Run the exact committed-export build, package-boundary and isolated local-pod smoke gates.
- [ ] App-only publish and verify exact-SHA image CI.
- [ ] Deploy only while live work is idle; preserve state, sidecars, mounts, credentials and schedules.

Implementation must reuse existing owners; retained plan approval/context is reference/provenance, not permission to
execute a report's recommended sequence. Integration tests run project code, so an explicit user execution is a
mutation distinct from report reads. Unknown/uncertain/stale results never authorize replay, acceptance or landing.

Implementation boundaries: integration requires an already-ready shared worker and enabled project checks; it never
starts/enables a worker or overrides pause/PID-pressure settings. Its synthetic jobs share the existing checks queue
but have their own export/database namespace and never write card QA/checks/objective state. Source environment files
are explicitly from the registered main checkout, bounded/hash-pinned through the existing runner. Unknown executions
or cleanup retain their reservation/candidate for operator investigation; this slice does not offer automatic replay,
recovery or release. Complete billing, critical-path duration forecasts, finer setup/provider-wait decomposition and
outcome-based assignment remain outside this slice. See `docs/fork/coordination-and-integration.md`.

Source validation passed: `npm run check` (3,062 product tests, both typechecks, clean formatter/lint), 762 UI tests
and 33 maintainer tests. Six owned shared-Chrome phone/desktop flows passed across coordination/integration,
canonical knowledge and discovery/efficiency; the final new phone/desktop cases were rerun after UI refinements.
The integration fixture combined exact disposable snapshots, ran real fixture-only checks through the existing
worker queue, confirmed source branch/board immutability and stale invalidation, and used no real model. An initial
fixture run failed because orderly shutdown cleaned its injected Review cards; `--skip-shutdown-cleanup` fixed the
fixture, not the product's lifecycle. A formatter rerun was needed; failed runs were not counted as passes.

Deployment preflight found live work active. No restart/prepare/update was performed and no automatic deployment
watcher was installed. Finish independent export/publication validation, but retain deployment as pending while
that work is active rather than interrupting it.
