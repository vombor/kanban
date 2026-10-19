# Developer completion, QA setup and CLI pipes

## Team developer completion (#71)

The fixed `team` kit supplies `dispatch.devCompletion: review` for every preset. This is a kit-owned role policy,
not a per-model rule, card prompt edit or new workflow. The shared physical-session admission owner adds its
agent-neutral contract to nonempty dev launches, including resumes/restarts; automated rework/recovery input is
prepared through the same native role/kit reader before the existing typed-input hold. No CLI-specific model switch
or extra supervising turn is introduced.

The default contract assigns implementation, requested docs/cleanup and focused unit/build checks to dev. It asks
devs to reuse passing checks, retry from concrete failure evidence, keep a concise requirement/progress record and
re-anchor after compaction. Routine live browser acceptance, screenshots and browser-QA tooling investigations
belong to independent QA. Explicit browser/tooling implementation and targeted reproduction of a QA rework finding
remain possible; they do not authorize an unrelated self-QA pass.

Once dev requirements and checks are complete, the agent should use its normal CLI completion/end-of-turn mechanism
with a concise summary, test/build results, startup instructions and limitations. Existing session sync moves it to
Review; the existing QA workflow consumes it. Dev must not start QA, invoke QA workflow commands, mark Done, bypass
review or wait for routine orchestrator approval. Genuine external blockers/product decisions still escalate after
reasonable self-recovery. These are role instructions, not a claim that every model obeys them or an enforcement
replacement for existing guards.

The native card role (including legacy role resolution) decides applicability. QA, plan, triage, calibration,
sidebar and missing-card inputs do not receive this dev stopping contract. The default/unrouted kit is unchanged.
Blank composers remain blank; live-session reuse is unchanged. Stored card prompts, acceptance criteria, immutable
pins and historical runs are not rewritten. QA retains its full browser/evidence/verdict responsibilities. Team QA,
rework, fallback and landing decisions still have their existing owners.

## Exact-tree setup (#68)

The authoritative append-only setup supplement inspects each extracted tree independently. A tree with package.json
and an npm lock uses npm ci; one with a manifest but no lock uses npm install. A tree without a package manifest
prints an explicit npm `not_run` outcome rather than running an invalid install. Present-but-broken manifests/locks
or installation failures still stop setup; an installer failure never triggers a different-installer fallback.

A README-only/non-application baseline needs no install, generator, database, server, tests or browser journey.
Record baseline comparison as not_applicable/not_run with exact-tree evidence and continue every applicable
candidate check/browser flow. No package.json alone is not proof that an arbitrary Python/other-language tree is
non-application: inspect its actual toolchain. Project notes may describe a non-app baseline but cannot waive
candidate failures or contradict exact-tree evidence. Generation uses installed project tools only where declared.

The legacy QA skeleton remains byte-for-byte compatible; the existing supplement explicitly overrides its
illustrative unconditional setup commands. No historical STALLED/FAIL/PASS or benchmark result is relabelled.

## Complete piped output (#70)

CLI commands intentionally force-exit after completion to avoid lingering SDK-host handles. Before that exit they
now drain stdout and stderr using queued write callbacks. Telemetry flushing is not an output drain. Scope-refusal
and startup-error exits drain too. A broken output stream produces unsuccessful exit rather than successful,
truncated JSON; slow consumers are allowed to drain, without an arbitrary truncating timeout. Server signal shutdown
keeps its existing separate lifecycle.

Tests cover a real slow pipe over 1 MiB, complete large task/settings JSON from an owned server, conditional setup
against a real README-only baseline and a locked application candidate, all preset/CLI role variants, and a fake
native dev CLI that runs unit/build checks, fires its generated completion hook, reaches Review and causes ordinary
QA creation/launch without a developer QA command or orchestrator nudge. The QA launch does not get the dev stopping
contract. These fixtures make no real model calls and are not performance/quality claims about a model.
