# Routing kits

A **routing kit** is the per-project policy the team workflow asks for its routing decisions. It is a JSON
document: data only, no code. The **core** (built into Kanban, the same for every project, see
[WORKFLOW.md](WORKFLOW.md)) does the mechanics: landing, snapshots, the QA gate, the rework loop, recovery and
the watchdog. Whenever a mechanic needs a routing decision, it asks the project's kit. The kit never decides how
something is done, and the core never decides who does it.

- Every project is on the built-in **`default`** kit unless its config entry names another one. `default` answers
  "no" to every question, so a project on it behaves like upstream Kanban.
- **`team`** is the built-in preset for the dev-team workflow (Cline juniors on tier-3 models, cross-vendor QA,
  same-model rework, then a fallback model, then the orchestrator).
- **`team-local`** is the same workflow on local Lemonade models only (Cline + provider `lemonade`, nothing paid
  or in the cloud), with a fallback local model before the orchestrator. See [The `team-local` kit](#the-team-local-kit).
- **User kits** live in `<home>/kits/<name>.json`.

A kit is the **team definition**: its roles with a default model each, and the flow. A project changes only its
**project settings** on top (role models and project facts, [Project settings](#project-settings)); a different
team is a different kit.

Code: `src/kits/kit-schema.ts` (schema), `src/kits/kit-roles.ts` (roles and the fallback flow),
`src/kits/project-settings.ts` (what a project may set), `src/kits/kit-legacy-keys.ts` (keys from before the split), `src/kits/resolve-kit.ts` (resolver), `src/kits/policy.ts` (the one
evaluator), `kits/default.json`, `kits/team.json`, `kits/team-local.json`. Plan: `docs/fork/kit-merge-plan.md` §3.2-§3.4, §4.0.

## The questions

The core asks five questions (`RoutingPolicy` in `src/kits/policy.ts`). It always passes the card's **effective**
agent and model: the agent the card's session ran on, else `card.agentId`, else the agent selected in Kanban
settings (`resolveEffectiveAgent()`). It never passes the literal `card.agentId`. A card with no `agentId` runs on
the selected agent, and on 2026-10-06 misreading that QA'd and landed a whole board that was meant to be landed
by hand.

| Question | Asked by | When | The `default` kit's answer |
|---|---|---|---|
| `devAssignment` | card creation (CLI `task create`, the create dialog via tRPC `workspace.getDevAssignment`) | the creator set no agent and no model | `null`: the card runs on the selected agent with its own model |
| `qaPolicy` | the QA gate | a dev card is submitted (settled in Review with work) on a landing-`qa` project | `none` |
| `onFail` | the rework loop | a FAIL or STALLED verdict, a merge conflict at land, or a rework that came back unchanged | `stop` |
| `onPass` | the QA gate | a PASS for the card's current snapshot | `land` |
| `onOutage` | recovery (where the rework loop runs: landing `qa`, not shadow) | a dev card is in a provider outage hold | `hold`: the hold runs to `pipeline.recovery.outage.maxMin`, then goes to the orchestrator |
| `planAssignment` | plan card creation (`kanban task create --role plan`), never the pipeline (`answerPlanAssignment()`) | a plan card is created | `disabled`: no plan cards |

The core keeps these guarantees whatever the kit says:

- **An explicit choice wins.** An agent or model set by the card's creator is never replaced by `devAssignment`.
  The create dialog only preselects the kit's proposal and shows "from kit `team`".
- **Only dev cards are asked about.** QA, TRIAGE, calibration and plan cards (`role`, or the legacy kit's title and
  prompt markers through `resolveCardRole()`) are never QA'd, reworked or landed.
- **Nothing lands without a verdict or a human.** With landing `qa` and the answer `none`, the card waits in
  Review for Approve & land.
- **The FAIL cap is the core's.** At `pipeline.rework.maxFailRounds` FAIL rounds (land conflicts count, plus any
  extra rounds a handback granted) the core escalates whatever the kit says. Below the cap the kit decides. At the
  cap the core still asks the kit, so that it can keep the kit's escalation target.
- **A rework can't switch model.** It is refused (and escalated) when the card's session ran on a different agent
  or model than the card names, or when there is nothing to resume on that model.
- **A fallback never repeats itself** (#8). A hand-over to the fallback role (a FAIL, a stall, an outage) goes to
  the orchestrator instead when the fallback is the model the card runs on, when the card is itself a sibling that
  took the task over (otherwise the fallback sibling would fall back onto the fallback again, sibling after
  sibling), or when the card races in a runoff (`refuseTakeover()` in `src/pipeline/rework.ts`). No kit can turn
  this off.
- **`fallback.requireApproval` parks the sibling.** It waits in Backlog until the orchestrator or the user starts
  it. Either way the original card goes to Backlog as `BLOCKED: …`.
- **Only a hold stops a PASS from landing.** The hold is answered by the team kit's `runoffs` feature;
  `kanban task release-hold` is the human way out.

## Resolution

A key's value comes from the first of these that has it:

1. The workspace's project settings: `kit.overrides` in config.json (dotted key → value, e.g. `"qa.blurb"`).
2. The named kit.
3. The `default` kit.

A role names a `model` or a `tier`, never both: a layer that sets one drops the other's value from the layers
below, so a project's `roles.dev.model` replaces the kit's `roles.dev.tier` (its provider then comes from
`roles.dev.provider`, else the agent's default).

Arrays are replaced, never merged: overriding `qa.routes` replaces the whole list. Nothing is inherited from another
workspace, and there is no top-level routing key a project could pick up by accident. A workspace without a `kit`
entry gets `default`. If the named kit is missing, or its overrides don't validate, the workspace falls back to
`default` and `kanban doctor` / `kanban kit show` report it.

```jsonc
// <home>/config.json
"workspaces": {
  "foo":         { "landing": { "mode": "qa" }, "kit": { "name": "team", "overrides": { "qa.blurb": "Project: Pawsome…" } } },
  "kanban-2uge": { "landing": { "mode": "off" } }   // no kit: default
}
```

`kanban kit show --project <ws>` prints the team definition (each role's effective agent and model with its
source, the fallback and its triggers), the project settings with their history, and every resolved value with its
source (`project`, the kit's name, or `default`). The pipeline worker reads the kit and its overrides on every evaluation, so a kit change needs no
restart.

The landing mode is a core setting ([CONFIG.md](CONFIG.md)), not a kit key. Applying a kit never changes it.
`kanban kit apply team --project foo --landing qa` sets both in one step on purpose.

## Schema

`"kit": 1` is the schema version. The schema is strict: an unknown key is an error at `kanban kit apply` (and in a
user kit file), never a silent no-op. A missing key means "no answer", so the `default` kit's value applies.

| Key | Type | Used for | `default` | `team` |
|---|---|---|---|---|
| `kit` | `1` | schema version | `1` | `1` |
| `name` | lowercase `[a-z0-9_-]`, the file name | | `default` | `team` |
| `description` | text | `kanban kit list` | | |
| `roles.dev` | `{ agent?, provider?, model? \| tier?, note? }` | `devAssignment`: the agent and model of new dev cards (model needs agent) | none (→ `null`) | `cline`, tier `tier3` |
| `roles.qa` | same | `qaPolicy`: the QA agent and model when no route matches. No model = the agent's own default (Codex: `~/.codex/config.toml`) | none | `codex` |
| `roles.plan` | same | `planAssignment`: the planner; no agent = the selected agent, no model = the agent's own default | none | `claude` |
| `roles.fallback` | same | the model a dev card's task falls back to (`fallback.on`). No agent = the dev role's agent, else the card's; a tier needs the `tiers` feature | none | tier `tier2` |
| `qa.enabled` | boolean | `qaPolicy`: does a dev card get QA at all | `false` | `true` |
| `qa.skip.roles` | roles | `qaPolicy`: roles that never get QA | `qa`, `triage`, `calibration`, `plan` | same |
| `qa.skip.effectiveAgents` | agent ids | `qaPolicy`: effective agents whose cards never get QA | `[]` | `[]` |
| `qa.routes[]` | `{ devModel, agent, model?, provider?, rules?, why? }` | `qaPolicy`: `devModel` is a regex on the dev card's effective model; first match wins | `[]` | OpenAI-built → `cline` + Haiku 4.5, rules `["drive"]` |
| `qa.requireDifferentVendor` | boolean | `qaPolicy`: refuse (answer `none`) a route whose QA model has the dev model's vendor | `false` | `true` |
| `qa.rules.<name>` | text | QA prompt steps a route names in `rules`; `{outbox}` is filled in | `{}` | `drive` |
| `qa.blurb` | text | the "Project: …" line of the QA prompt | `""` | `""` (foo overrides it) |
| `qa.promptNotes.{screenshotFallback,knownBaseIssues,dbSetup}` | text | project sentences in the QA prompt | `""` | `""` (foo overrides `dbSetup`) |
| `qa.serversScript` | path or null | the script QA uses to start the project's servers in its scratch copy | `null` | `null` |
| `qa.preview` | `{ pidFile, start, stop }` or null | the preview QA screenshots go through. Started before a QA card when down, stopped after `pipeline.qa.previewIdleMin` idle minutes, only if the pid is still the one the QA gate started | `null` | `null` |
| `plan.enabled` | boolean | `planAssignment`: does the project make plan cards at all | `false` | `true` |
| `plan.startInPlanMode` | boolean | the plan card starts in the agent's plan mode | `false` | `true` |
| `plan.rules.<name>` | text | project rules added to the plan prompt, in key order | `{}` | `{}` |
| `plan.candidates[]` | `{ agent, model?, note? }` | agents and models a later runoff or calibration compares; never read for routing | `[]` | `claude` |
| `plan.note` | text | | | why there is no model pin |
| `onFail.rework` | `none` \| `same-model` | `onFail`: hand a FAIL back to the same card and model | `none` | `same-model` |
| `onFail.reworkRounds` | integer | `onFail`: FAIL rounds before `then` (capped by `pipeline.rework.maxFailRounds`) | `0` | `3` |
| `onFail.conflict` | `stop` \| `rework` | `onFail`: a merge conflict at land | `stop` | `rework` |
| `onFail.then` | `escalate` \| `stop` | `onFail`: after the rounds run out, after STALLED, after an unchanged rework | `stop` | `escalate` |
| `onFail.runoff` | `{ models: [{ agent, model, provider? }] }` or null | `onFail`: race sibling cards on these models (needs the `runoffs` feature, else escalates) | `null` | `null` |
| `fallback.on.qaFails` | boolean | `onFail`: after `onFail.reworkRounds` failed QA rounds, hand the task to `roles.fallback` (else the orchestrator) | `false` | `true` |
| `fallback.on.qaStalled` | boolean | `onFail`: the same for QA STALLED/DNF | `false` | `true` |
| `fallback.on.unchanged` | boolean | `onFail`: the same for a rework that came back unchanged | `false` | `true` |
| `fallback.on.conflict` | boolean | `onFail`: the same for a merge conflict its reworks didn't fix (`onFail.conflict: rework`) | `false` | `true` |
| `fallback.on.outage` | boolean | `onOutage`: hand an outage-held card to the fallback after `fallback.outageAfterMin` | `false` | `true` |
| `fallback.outageAfterMin` | number | minutes of outage hold before the outage trigger fires | `pipeline.recovery.outage.maxMin` | (default) |
| `fallback.requireApproval` | boolean | the fallback sibling waits in Backlog for the orchestrator or the user | `false` | `false` |
| `land.postLand[]` | `{ paths, run, stopUnder? }` | commands the core runs after a land that touched a file matching `paths` (regex) | `[]` | `[]` (foo overrides it) |
| `features[]` | `scoreboard`, `bench`, `runoffs`, `calibration`, `tiers` | built-in team features that run for the project | `[]` | all five |
| `tiers.<name>[]` | `{ provider?, model, default?, note? }` | `roles.<role>.tier`, `kanban bench tiers`, `bench runoff create --tier` | | `tier3`, `tier2`, `tier1`, `qa` |
| `dropped[]` | `{ provider?, model, at?, why? }` | models no tier lookup returns, on any provider | | five models |
| `tierRules`, `tierNotes` | text per tier | shown by `kanban bench tiers` | | |
| `prices.{region,autoSync}` | | the `bench` feature's daily AWS price check | | `us-west-2`, `true` |
| `recommends.landingMode` | landing mode | shown by `kanban kit show/apply`, **never applied** without `--landing` | | `qa` |
| `recommends.settings[]` | `{ key, op?, value, why }` | core settings the kit's routing needs: `key` is a dotted config.json key (`workspace.` = the project's own `workspaces.<id>` entry), `op` `equals` (default), `atMost` or `atLeast`. Shown by `kanban kit show/apply` and warned about by `kanban doctor` when unmet, **never applied** | | (team-local: three) |

Checks across keys run on the resolved kit:

- a `{ tier }` reference must name a tier with at least one model that isn't dropped;
- at most one entry per tier has `default: true`;
- a route's `rules` must exist in `qa.rules`;
- a role names a model or a tier, not both; `provider` needs `model`; a model or tier needs the role's `agent`
  (except `roles.fallback`, which runs on the dev role's agent);
- a `fallback.on` trigger that is on needs `roles.fallback`.

### Legacy keys

Kits and overrides from before the team/project split may still use the old keys. Each layer is translated before it
is merged (`src/kits/kit-legacy-keys.ts`), so they keep working with their layer's precedence, and a resolved kit
(and `kanban kit show`) only has the new keys. `kanban kit set` refuses them; `kanban doctor` warns about them.

| Legacy key | Means |
|---|---|
| `dev.agent`, `dev.model` | `roles.dev.agent`, `roles.dev.tier` or `roles.dev.{provider,model}` |
| `qa.default.{agent,provider,model}` | `roles.qa.{agent,provider,model}` |
| `plan.agent`, `plan.model` | `roles.plan.*` |
| `escalate.to: "orchestrator"` | every `fallback.on` trigger off (outages included) |
| `escalate.to: { tier }` / `{ agent, model, provider? }` | `roles.fallback` (no provider = the agent's default), and `fallback.on.{qaFails,qaStalled,unchanged,conflict}` on |
| `escalate.requireApproval` | `fallback.requireApproval` |
| `onOutage.then: "escalate" / "orchestrator"` | `fallback.on.outage: true / false` |
| `onOutage.afterMin` | `fallback.outageAfterMin` |

## Project settings

A project's settings are what it sets on its kit: `workspaces.<id>.kit.overrides` in config.json, now limited to

- **role models**: `roles.<role>.agent|provider|model|tier`, for a role the project's kit defines (`dev`, `qa`,
  `plan`, `fallback`; an unknown role, or one the kit doesn't define, is an error);
- **project facts**: `qa.blurb`, `qa.promptNotes.{dbSetup,knownBaseIssues,screenshotFallback}`, `qa.serversScript`,
  `qa.preview`, `land.postLand`, `plan.rules` (`PROJECT_FACT_KEYS` in `src/kits/project-settings.ts`).

Everything else is the team definition and is refused with a message: `onFail.*`, `fallback.*` (the triggers and
the approval rule), `qa.enabled`, `qa.requireDifferentVendor`, `qa.skip`, `qa.routes`, `qa.rules`, `tiers`,
`dropped`, `features`, `plan.enabled`, `recommends`, `description`, `roles.<role>.note`. A project changes its
team by using another kit, and that is the user's `kanban kit apply`.

```sh
kanban kit set roles.fallback.model us.moonshotai.kimi-k3 --project /projects/foo
kanban kit set roles.fallback.agent codex --project /projects/foo
kanban kit set qa.promptNotes.dbSetup "npx prisma migrate deploy" --project /projects/foo
kanban kit set land.postLand '[{"paths":"^prisma/","run":"npx prisma generate"}]' --project /projects/foo
kanban kit unset roles.dev.model --project /projects/foo       # the kit's dev model again
kanban kit unset roles.fallback --project /projects/foo        # every field of the role
kanban kit set onFail.reworkRounds 5 --project /projects/foo   # refused: part of the team definition (kit team)
```

The value is JSON when it parses as JSON (`true`, `3`, `null`, `[…]`, `{…}`, `"text"`), else the text itself. A
change applies at once (the pipeline reads the kit on every evaluation): no card, no land, no approval code.

**Who.** `kanban kit set|unset` go through the running server (tRPC `kit.set`/`kit.unset`,
`src/trpc/kit-settings-api.ts`), which decides the caller with the strict lookup (a session without its credential
is traced to its process tree), in every isolation mode, off included:

| Caller | |
|---|---|
| the user (the browser, the user's own shell) | allowed |
| the project's own orchestrator (its sidebar session or its headless wake) | allowed |
| another project's orchestrator | refused (send that project's orchestrator a message) |
| any card session, of this project or another | refused |
| an unidentified caller (a credential outside its process tree) | refused |

The CLI also refuses `kit set|unset` in a card session before it asks the server (`ORCHESTRATOR_OR_USER_COMMANDS`),
and every refusal is logged to `data/<ws>/isolation.jsonl`.

**Where.** Project settings stay in config.json (`workspaces.<id>.kit.overrides`), not in the project repo: a card
can edit and land repo files, which is the problem this avoids. They are the resolver's existing input, written
atomically under the config lock, and moved with the rest of `workspaces.<id>` by `kanban project rename-id`.
Every change is appended to `data/<ws>/kit-settings-history.jsonl` (one JSON line: `at`, `kitName`, `key`, `from`,
`to`, `by` = user / orchestrator with its session id / a user-run command, `via` = `kit set`, `kit unset`,
`kit apply` or `kit migrate-overrides`). `kanban kit show --project` prints its path and the last change.

**Overrides from before the split.** Legacy keys and team keys stored as overrides keep applying. `kanban doctor`
warns about each project that has them and points at `kanban kit migrate-overrides --project <ws> --dry-run`, the
user's command (an agent session can't run it; doctor `--fix` doesn't either). It

1. turns legacy model keys into their `roles.*` keys;
2. keeps role models and facts as project settings;
3. drops team keys the kit already has with the same value;
4. puts the remaining team keys into a new user kit `<home>/kits/<ws>-team.json` (`--into <name>`): the project's
   kit with them applied, and switches the project to it;
5. refuses unless the project resolves to exactly the same routing afterwards, and logs every change.

A model id's vendor (for `qa.requireDifferentVendor`) is `getModelVendor()` in `src/kits/policy.ts`: a Bedrock
`<vendor>.` prefix, or a known family name for bare local ids (`GLM` → `zai`, `Devstral`/`Mistral` → `mistral`,
`Qwen` → `qwen`, `Gemma` → `google`, `DeepSeek` → `deepseek`), named like the Bedrock vendors so a local and a
Bedrock model of one family count as one vendor. An id it can't place gives no vendor, and the rule doesn't refuse.

A tier lookup returns the tier's `default` entry, else its first usable one, and skips `dropped` models
(`src/kits/tier-lookup.ts`).

## How the evaluator answers

`createRoutingPolicy()` in `src/kits/policy.ts` is the only evaluator. A kit can't add code to it.

**`devAssignment`.** `roles.dev.agent`, with its model or tier resolved (a tier → its model). Without
`roles.dev.agent` the answer is `null`. The provider comes from the model entry, else from `kanban models providers --for <model>`. With
`workspaces.<id>.pipeline.shadow` on, the proposal is only logged (`data/<ws>/dev-assignment.jsonl`); the card is
created as its creator set it.

**`qaPolicy`**, first match wins:

1. a role other than `dev` → `none`;
2. `qa.enabled` not `true` → `none`;
3. the role is in `qa.skip.roles`, or the effective agent is in `qa.skip.effectiveAgents` → `none`;
4. the first `qa.routes[]` entry whose `devModel` matches the effective model, else `roles.qa`; neither → `none`;
5. with `qa.requireDifferentVendor`, a QA model from the dev model's vendor → `none` (refused, with the reason).

A Cline card with no model of its own counts as the Cline CLI's default model (`resolveEffectiveModel()`). The
`qa` answer carries the prompt parts (blurb, notes, servers script, and the texts of the route's `rules`). The core
puts them into its QA prompt skeleton (`src/pipeline/qa-prompt.ts`).

**`onFail`**, by cause:

- `stalled` / `unchanged` → `onFail.then`.
- `conflict` with `onFail.conflict: "stop"` → `stop`. Otherwise a conflict is reworked (it counts as a FAIL round).
- `fail` with `onFail.rework: "none"` → `onFail.then`.
- the cap is `min(onFail.reworkRounds, pipeline.rework.maxFailRounds)` plus the handback rounds. At the cap →
  `onFail.then`.
- below the cap: `onFail.runoff` if set (only for a FAIL), else `rework`.

`onFail.then: "escalate"` hands the card to the fallback when the cause's trigger is on (`fallback.on.qaFails` for
FAIL rounds, `qaStalled`, `unchanged`, `conflict`) and `roles.fallback` resolves to a model, with
`fallback.requireApproval`; otherwise it escalates to the orchestrator. `"stop"` answers `stop`. A stopped card
stays in Review: one ATTENTION.md line, and the orchestrator is woken.

**`onOutage`**, asked for a dev card in a provider outage hold (recovery holds a card once its provider-error
retries are used up and the provider has a probe):

- `fallback.on.outage` off → `hold`: the hold probes on, and at `pipeline.recovery.outage.maxMin` the card goes
  to the orchestrator.
- held less than `fallback.outageAfterMin` (default `maxMin`) → `hold`.
- no fallback model, or the fallback is the model the card runs on → `hold` (nothing to take it over).
- otherwise → `escalate` to the fallback with `fallback.requireApproval`. Recovery ends the hold
  (`qaflow.takeover`) and the rework loop hands the task to a sibling card on that model, as for a FAIL
  escalation; no FAIL round is counted. A provider outage is the only recovery stop that takes a card over: an
  agent's `STATUS: BLOCKED`, repeated crashes or stalls still go to the orchestrator.

**`planAssignment`.** `plan.enabled` not `true` → `disabled`, and `kanban task create --role plan` is refused (the
dev agent plans its own work). Otherwise `roles.plan.agent` (or the selected agent), its model resolved like the dev
role's (none = the agent's own default), `plan.startInPlanMode` and the `plan.rules` texts. An agent, model
or `--start-in-plan-mode` the creator sets wins. `pipeline.shadow` doesn't hold it back: there is no legacy
planner to compare with. The flow around plan cards is [WORKFLOW.md](WORKFLOW.md) §13.

**`onPass`.** Always `land`. A feature may answer first: the team `runoffs` feature holds the PASS of a card in an
open runoff (`hold`). A feature that fails to answer leaves the PASS for the next evaluation and never lands it.

## The `default` kit

`kits/default.json`. It is the value of every key the other kits leave out. As a project's kit, it gives:

- cards run on the agent selected in Kanban settings, with that agent's model;
- no QA, no rework automation, and a FAIL (there are none without QA) stops;
- no plan cards (`plan.enabled: false`): the agent plans its own work;
- no features.

With landing `off` (the default), the orchestrator or the user lands. With landing `qa` on `default`, every
submitted card waits for Approve & land.

## The `team` kit

`kits/team.json`: the dev-team routing that ran the `foo` project under the legacy kit, as data. P4-T1 checked
parity against the legacy kit's live config (`test/runtime/kits/team-parity.test.ts`,
`team-qa-routing.test.ts`, `team-qa-prompt.test.ts`).

- **Dev:** Cline on the `tier3` default (`us.openai.gpt-6.1-sol` on bedrock).
- **Plan:** plan cards on Claude with the Claude CLI's default model (no pin), starting in plan mode (user
  2026-10-07). `plan.candidates` lists only Claude for now; benchmarking other models and auditioning Copilot and
  Codex come later and need no schema change.
- **QA:** every dev card. OpenAI-built cards (`(^|\.)openai\.|^gpt-`) get Cline on Haiku 4.5 plus the `drive` rule
  ("log in and drive the changed path, screenshot it"). Everything else gets Codex with its own model. The QA
  vendor must differ from the dev vendor.
- **FAIL:** same-model rework for 3 rounds (conflicts too, with rebase notes), then the **fallback**.
- **Fallback** (since 2026-10-09, user: it is team definition, not one project's overrides; foo ran it through
  `escalate.to`/`escalate.requireApproval: false`/`onOutage.then: escalate` overrides before): `roles.fallback` is
  the `tier2` pick (`us.moonshotai.kimi-k3` on bedrock) on the dev role's agent. It takes the task over on a
  sibling card, started at once (`requireApproval: false`), after 3 failed QA rounds, a QA stall, an unchanged
  rework, a conflict its reworks didn't fix, or a provider outage hold that lasted `pipeline.recovery.outage.maxMin`.
  A fallback sibling that fails goes to the orchestrator. A project picks its own fallback model with
  `kanban kit set roles.fallback.agent|model` (foo: Codex on kimi-k3).
- **Features:** `scoreboard`, `bench`, `runoffs`, `calibration`, `tiers`.
- **Recommends** landing `qa`.

One known difference from the legacy kit: Claude-built dev cards get QA (by Codex). The legacy kit skipped them only
because of a literal `agentId === "claude"` check. To skip them, set `qa.skip.effectiveAgents: ["claude"]` as an
override (plan §12).

## The `team-local` kit

`kits/team-local.json`: the team workflow on the local Lemonade server (http://localhost:13305/api/v1, OpenAI
compatible) through the Cline CLI with provider `lemonade`. No paid or cloud provider appears anywhere in it
(`test/runtime/kits/team-local-kit.test.ts` checks every model and agent). Every model pick is **provisional**
until `kanban bench calibrate` picks the final ones on the project.

| Role | Model (provisional) | Why |
|---|---|---|
| Dev (`roles.dev`: tier `dev`), plan cards (`roles.plan`, Cline `--plan`) | `GLM-4.7-Flash-GGUF` | tool-calling; a 30B-A3B MoE, so fast on one GPU; MLA attention keeps its KV cache small (131072 context in the memory budget, max 202752); already Cline's Lemonade default. Plans on the dev model need no model swap |
| QA (`roles.qa`) | `Devstral-Small-2507-GGUF` | another family (Mistral) than GLM, coding + tool-calling; 65536 context in the memory budget (its KV cache is the largest). Text-only |
| QA of Mistral-built cards (`qa.routes[0]`) | `GLM-4.7-Flash-GGUF` | Devstral can't review its own family |
| Fallback dev model (`roles.fallback`: tier `senior`) | `Qwen3.6-35B-A3B-MTP-GGUF` | a third family, neither the dev nor the QA model, so its sibling is still reviewed by Devstral. 65536 context as Lemonade loads it (its KV cache is small, so a bigger one costs little memory) |

The other coding models are candidates in `tiers` (`Devstral`, `Qwen3.6` and `DeepSeek-V4-Flash-0731-GGUF-BF16` for
dev; `GLM`, `Qwen3.6` and `Gemma-4-12B-it-GGUF` for QA, the last two with vision). `LMX-Omni-52B-Halo` is in
`dropped`: it is a Lemonade collection (Qwen3.6 + image + speech models) without the tool-calling label, so Cline's
Lemonade list doesn't offer it.

- **FAIL:** same-model rework for 3 rounds (conflicts too), then the fallback: a sibling card on Qwen3.6 takes the
  task over and starts at once (`requireApproval: false`: a local run costs nothing). The core never hands a task
  onto the model the card runs on, and a fallback sibling that fails in turn goes to the orchestrator, never to
  another sibling (`refuseTakeover()` in `src/pipeline/rework.ts`). So the orchestrator is the last resort, after
  the fallback has failed too.
- **Outage:** `fallback.on.outage: false` (the same fallback structure as `team`, with this trigger off). Lemonade down (connection refused, `/health` not `ok`) is a provider
  outage: recovery holds the card and probes `/health` every `pipeline.recovery.outage.probeEveryMin`, resumes it
  when Lemonade is back, and gives it to the orchestrator at `maxMin`. A takeover would not help: every model in the
  kit runs on the same server.
- **Features:** `scoreboard`, `bench`, `calibration` and `tiers` (the fallback is a tier). Dropped:
  - `runoffs` races sibling cards on several models at once, which one GPU can only do by swapping models on every
    request;
  - the `bench` feature's daily AWS price check (`prices.autoSync: false`): local models have no AWS price, and
    the check skips local-provider models anyway.
- **Costs:** a turn on provider `lemonade` costs 0 whatever the model id (`LOCAL_PROVIDER_IDS` in
  `src/kits/team/bench/prices.ts`), so the scoreboard, `kanban bench metrics` and the calibration results show
  `$0.00`, not "no price".
- **Recommends** landing `qa`.

### One GPU: keep dev, QA and fallback loaded

team-local runs three local models at the same time: GLM (dev and plan), Devstral (QA) and Qwen3.6 (fallback).
Lemonade keeps at most `max_loaded_models` LLMs resident (`/api/v1/health` `max_models.llm`, default 1). When it is
full it evicts the least recently used one, so with one slot every dev ↔ QA switch reloads a model. Raise it to 3:

- Lemonade's container image: the env var `LEMONADE_MAX_LOADED_MODELS=3`, then restart the container;
- otherwise `lemonade config set max_loaded_models=3` (applies live and is saved in Lemonade's config.json).

Pinning (`lemonade pin`, `"pinned": true` on `/api/v1/load`) is not needed and not recommended: with enough slots
LRU keeps all three, and a full set of pinned models makes the next load fail with 409 `slots_pinned_error`.

Kanban's own limit, `models.providerCapacity.lemonade.maxLoadedModels` (default 1), must match Lemonade's:

- recovery's retries, nudges and restart resumes, and the QA gate's QA card starts, wait while In Progress cards
  hold that many other Lemonade models. The QA gate records the hold once ("waiting for provider lemonade … held
  by …");
- `kanban bench calibrate` refuses a spec with more Lemonade models than that and `parallel` above it.

Above Lemonade's value, cards on different models make it reload on every request. Below it, QA cards wait for
nothing. `kanban doctor` and `kanban kit show` read `/api/v1/health` and warn about both cases, and when
`max_models.llm` is below the 3 models the kit runs. With Lemonade at 1 and Kanban at 1, work runs one model at a
time: a QA card waits until no dev card runs on GLM, and every switch still costs a model load. Not covered yet: a
card a human starts by hand, and the rework stage's sibling and resume starts.

**Memory budget** (`tierNotes.dev`): the three models must stay resident within 80 GB of the 96 GB the iGPU can
address (Ryzen AI MAX+ 395, 125 GB RAM), leaving 16 GB headroom. Weights are Lemonade's sizes; the KV cache is f16,
from each model's architecture config:

| Model | Context | Weights | KV cache | Total |
|---|---|---|---|---|
| GLM-4.7-Flash (MLA, 54 KB/token) | 131072 | 16.3 GB | 7.1 GB | 23.4 GB |
| Devstral-Small-2507 (8 KV heads × 40 layers, 160 KB/token) | 65536 | 13.3 GB | 10.7 GB | 24.0 GB |
| Qwen3.6-35B-A3B (10 of 40 layers full attention, 20 KB/token) | 65536 | 22.1 GB | 1.3 GB | 23.4 GB |
| compute buffers (about 1.5 GB each) | | | | 4.5 GB |
| **sum** | | | | **about 75 GB** |

Lemonade's current contexts (GLM 202752, Devstral 131072) add about 15 GB, which puts the total near 90 GB, over the
budget. Set the two contexts in Lemonade (`--save-options` replaces the model's stored options, so repeat the
backend), then let Cline's models.json follow:

```sh
lemonade load GLM-4.7-Flash-GGUF --ctx-size 131072 --llamacpp vulkan --save-options
lemonade load Devstral-Small-2507-GGUF --ctx-size 65536 --llamacpp vulkan --save-options
kanban cline apply-lemonade-models --origin <kanban origin>    # doctor's "cline lemonade models" row prints it
```

### Settings team-local needs

The kit lists them in `recommends.settings`; Kanban's Lemonade limit is checked against Lemonade itself (above). `kanban kit show` prints each with its current value, `kanban kit apply`
lists the unmet ones, and `kanban doctor` warns for every project on the kit whose config lacks one. None is
applied for you:

| Setting | Value | For |
|---|---|---|
| `agents.cline.turnDetector.mode` | `on` | Lemonade/llama.cpp ends Cline turns without the TaskComplete hook; only the turn detector in mode `on` ends them (`report` only logs) |
| `pipeline.recovery.mode` | `on` | a no-images rejection is cleared and resent (with "never read image files"), a poisoned or overflowing context is cleared and resent, a Lemonade outage is held and probed instead of escalated |
| `workspaces.<id>.recovery.enabled` | `true` (default) | the same, for this project |

The other local gotchas:

- **Images.** Devstral and GLM are text-only. `qa.promptNotes.screenshotFallback` tells QA never to open PNGs and to
  judge from the screenshot tool's text reports.
- **Context overflow.** Cline compacts at 0.9 × the `contextWindow` in its models.json, so that window must be the
  one Lemonade really loads. `kanban doctor`'s "cline lemonade models" row compares them, and
  `kanban cline apply-lemonade-models --origin <origin>` (the user's command) fixes models.json. Beyond that,
  recovery (mode `on`) clears an overflowed history.
- **Models.** `kanban doctor` also warns when Lemonade doesn't list a model the kit routes to, hasn't downloaded it,
  or doesn't mark it tool-calling. It reports INFO when Lemonade is down.

### Applying it to a new project

```sh
kanban project create /projects/<name>                    # or: kanban project add /projects/<name>
kanban kit apply team-local --project /projects/<name> --landing qa --dry-run
kanban kit apply team-local --project /projects/<name> --landing qa
kanban kit show --project /projects/<name>                # routing + "Settings this kit needs"
kanban doctor /projects/<name>                            # warns about unmet settings and missing models
```

### Calibrating it

`kanban bench calibrate` runs the same QA review, on fixed snapshots, by every QA candidate. It needs finished dev
work: a few dev cards on the project whose commits (`ref`), bases (`base`) and card ids (`fromCard`) become the
spec's `sets`. Keep `parallel` at 1, or the command refuses the spec (one GPU):

```jsonc
// /projects/<name>/calibration/local-qa-v1.json (anywhere works; results go to <home>/data/<ws>/calibration/local-qa-v1/)
{
  "name": "local-qa-v1",
  "parallel": 1,
  "timeoutMin": 120,
  "maxCostUSD": 10,
  "sets": [
    { "id": "A", "ref": "<commit with the work>", "base": "<its base commit>", "fromCard": "<dev card id>", "expect": "PASS" },
    { "id": "B", "ref": "<commit with a known bug>", "base": "<base>", "fromCard": "<dev card id>", "expect": "FAIL" }
  ],
  "models": [
    { "key": "devstral", "agent": "cline", "provider": "lemonade", "model": "Devstral-Small-2507-GGUF" },
    { "key": "glm", "agent": "cline", "provider": "lemonade", "model": "GLM-4.7-Flash-GGUF" },
    { "key": "qwen36", "agent": "cline", "provider": "lemonade", "model": "Qwen3.6-35B-A3B-MTP-GGUF" },
    { "key": "gemma4", "agent": "cline", "provider": "lemonade", "model": "Gemma-4-12B-it-GGUF" }
  ]
}
```

```sh
kanban bench calibrate /projects/<name>/calibration/local-qa-v1.json --project /projects/<name> --print   # checks inputs only
kanban bench calibrate /projects/<name>/calibration/local-qa-v1.json --project /projects/<name>
```

Results go to `results.md` in that directory. Calibration compares QA models only. Dev and fallback models are
compared on real cards: the scoreboard and `kanban bench tiers`. Once a model is picked, set it as the project's
role model: `kanban kit set roles.qa.model <id> --project <ws>` (likewise `roles.dev.model`, `roles.fallback.model`).

### The team features

They are built in (`src/kits/team/`) and run only for projects whose kit lists them in `features`.

| Feature | What | Data |
|---|---|---|
| `scoreboard` | one line per recorded verdict, escalation and Approve & land (events `verdictRecorded`, `escalated`, `landed`); rebuilds the Markdown table | `data/<ws>/scoreboard.jsonl`, `scoreboard.md` |
| `bench` | card metrics (turns, tokens, list-price cost), `kanban bench metrics|record-verdict|scoreboard|reset`, the daily AWS price check (a watchdog feature job) | `data/prices/` |
| `runoffs` | holds the PASS of every card in an open runoff, decides once all have passed or escalated (mean QA score, then fewer FAIL rounds, then lower cost), lands the winner and tags and discards the losers through the Done workflow; `benchOnly` lands nothing | `data/<ws>/runoffs.json` |
| `calibration` | `kanban bench calibrate <spec>`: the same QA review on fixed snapshots by several QA models | `data/<ws>/calibration/<name>/` |
| `tiers` | a fallback by tier (`roles.fallback.tier`: a sibling card on that tier's model), `kanban bench tiers` | |

The scoreboard is the team kit's score of its routing decisions. It is not the core's record of verdicts (that is
`pipeline-state.json`), and no core decision reads it.

## Writing a user kit

1. Start from the kit closest to what you want: `kanban kit show team --json` prints it resolved.
2. Write `<home>/kits/<name>.json` with only the keys that differ from `default`. The file name must equal
   `name`, and `default`, `team` and `team-local` are taken.

   ```jsonc
   {
     "kit": 1,
     "name": "claude-qa",
     "description": "Claude Code builds, Codex reviews, one rework, then Codex takes over (approved), then the orchestrator",
     "roles": {
       "dev": { "agent": "claude" },
       "qa": { "agent": "codex" },
       "fallback": { "agent": "codex", "model": "gpt-6.1-sol" }
     },
     "qa": { "enabled": true, "requireDifferentVendor": true },
     "onFail": { "rework": "same-model", "reworkRounds": 1, "conflict": "rework", "then": "escalate" },
     "fallback": { "on": { "qaFails": true, "qaStalled": true }, "requireApproval": true },
     "recommends": { "landingMode": "qa" }
   }
   ```

3. `kanban kit list` shows it, or the reason it was refused (bad key, bad tier reference, name clash).
4. `kanban kit apply claude-qa --project <ws> --dry-run` prints what would change. Without `--dry-run` it writes
   `workspaces.<ws>.kit` and keeps the workspace's existing overrides. Add `--landing qa` to switch the landing
   mode in the same step.
5. Check the result: `kanban kit show --project <ws>` (every value and its source) and `kanban doctor <path>`.

Per-project models and facts belong in project settings, not in a copy of the kit: `kanban kit set` (the user or
the project's orchestrator, [Project settings](#project-settings)), or at apply time
`kanban kit apply team --project foo --set qa.blurb="Project: Pawsome…" --set 'land.postLand=[…]'` (`--set` takes
only project settings; `--unset <key>` removes any stored key).

What a kit can't do, on purpose:

- **No code hooks.** Runoff decisions, the scoreboard and calibration are code, so they are built-in features a kit
  switches on by name. A hook API gets added only when a real kit needs one.
- **No mechanics.** Landing mode, shadow, check scripts, limits and timings are core settings
  ([CONFIG.md](CONFIG.md)).
- **No inheritance.** A kit is resolved only over `default`, never over another user kit or another workspace.
