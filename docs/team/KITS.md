# Routing kits

A **routing kit** is the per-project policy the team workflow asks for its routing decisions. It is a JSON
document: data only, no code. The **core** (built into Kanban, the same for every project, see
[WORKFLOW.md](WORKFLOW.md)) does the mechanics: landing, snapshots, the QA gate, the rework loop, recovery and
the watchdog. Whenever a mechanic needs a routing decision, it asks the project's kit. The kit never decides how
something is done, and the core never decides who does it.

- Every project is on the built-in **`default`** kit unless its config entry names another one. `default` answers
  "no" to every question, so a project on it behaves like upstream Kanban.
- A new project **picks its kit when it is created or first added** ([Picking a kit for a new project](#picking-a-kit-for-a-new-project)),
  `default` preselected. Afterwards the project's kit is the one chosen then; it changes with `kanban kit apply`,
  run by the user or the project's own orchestrator ([Switching a project's kit](#switching-a-projects-kit)).
- **`team`** is the built-in dev-team workflow, the same for every project on it: cross-vendor QA, same-model
  rework, then a fallback model that takes the task over at once, then the orchestrator
  ([The `team` kit](#the-team-kit)). It holds no models. They come from a **preset** or from the project itself:
  - **presets** (`kits/presets/<name>.json`) name only models ([Presets](#presets)): **`cloud`** (AWS Bedrock,
    paid per token), **`cline`** (ClinePass, Cline's subscription provider, $0 per run) and **`lemonade`** (local
    Lemonade models only, nothing paid or in the cloud);
  - a **custom team** is `team` without a preset: the project sets each role's agent, provider and model itself
    ([Custom team](#custom-team)).
- **User kits** live in `<home>/kits/<name>.json`. They are full kits with a workflow of their own (foo's `team-foo`).

Until 2026-10-12 the built-in team kits were `team-cloud`, `team-local` and `team-cline`, each a full copy of the
workflow plus its models (and the copies had drifted apart). A config entry that still names one of them runs on
`team` with the matching preset ([Renamed kits](#renamed-kits)).

A kit is the **team definition**: its roles with a default model each, and the flow. A project changes only its
**project settings** on top (every model the kit names and project facts, [Project settings](#project-settings)); a
different flow is a different kit. On `team` the flow is fixed: a preset can't hold a workflow key (the preset schema
has none), and a project can't set one. Kits themselves are created and edited only by the user.

Any model may be on any role ([MODELS.md](MODELS.md)): the kit (on `team`, its preset) gives each role a default, the project overrides it
(`kanban kit set roles.<role>.*`), and Kanban doesn't refuse or warn about the choice. For Cline roles, Cline's
models.json is the allow list: `kanban doctor` warns when a role names a model its provider's models.json record
doesn't list (Cline couldn't select it).

Code: `src/kits/kit-schema.ts` (schema), `src/kits/kit-roles.ts` (roles and the fallback flow),
`src/kits/project-settings.ts` (what a project may set), `src/kits/kit-legacy-keys.ts` (keys from before the split), `src/kits/resolve-kit.ts` (resolver), `src/kits/policy.ts` (the one
evaluator), `src/kits/renamed-kits.ts` (the old kit names), `kits/default.json`, `kits/team.json`,
`kits/presets/cloud.json`, `kits/presets/cline.json`, `kits/presets/lemonade.json`. The built-in kits and presets are
JSON imports bundled into `dist/cli.js`, so a change to them needs a rebuild. Plan: `docs/fork/kit-merge-plan.md`
§3.2-§3.4, §4.0; presets: `docs/specs/team-kit-presets.md`.

## The questions

The core asks five questions (`RoutingPolicy` in `src/kits/policy.ts`). It always passes the card's **effective**
agent and model: the agent the card's session ran on, else `card.agentId`, else the agent selected in Kanban
settings (`resolveEffectiveAgent()`). It never passes the literal `card.agentId`. A card with no `agentId` runs on
the selected agent, and on 2026-10-06 misreading that QA'd and landed a whole board that was meant to be landed
by hand.

| Question | Asked by | When | The `default` kit's answer |
|---|---|---|---|
| `devAssignment` | card creation (CLI `task create`, the create dialog via tRPC `workspace.getDevAssignment`), and `kanban task reassign` for Backlog cards that never started | the creator set no agent and no model (reassign: the card names none, or is still on the kit's last logged assignment) | `null`: the card runs on the selected agent with its own model |
| `qaPolicy` | the QA gate | a dev card is submitted (settled in Review with work) on a landing-`qa` project | `none` |
| `onFail` | the rework loop | a FAIL or STALLED verdict, a merge conflict at land, or a rework that came back unchanged | `stop` |
| `onPass` | the QA gate | a PASS for the card's current snapshot | `land` |
| `onOutage` | recovery (where the rework loop runs: landing `qa`, not shadow) | a dev card is in a provider outage hold | `hold`: the hold runs to `pipeline.recovery.outage.maxMin`, then goes to the orchestrator |
| `planAssignment` | plan card creation (`kanban task create --role plan`), never the pipeline (`answerPlanAssignment()`) | a plan card is created | `disabled`: no plan cards |

The core keeps these guarantees whatever the kit says:

- **An explicit choice wins.** An agent or model set by the card's creator is never replaced by `devAssignment`.
  The create dialog only preselects the kit's proposal and shows which kit it comes from (e.g. `team (cloud)`).
- **A card keeps what it was created with.** Applying or changing a kit doesn't touch existing cards, and clearing
  a card's agent (`kanban task update --agent-id default --provider default --model default`, or the editor's
  first agent option, the selected one) makes it run on the agent selected in Kanban settings, not on the kit's
  dev role. `kanban task reassign` (below) is the one way to give existing cards the kit's current assignment.
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
- **`fallback.requireApproval` parks the sibling** (a user kit only: `team` has it off, for every preset and
  custom team). It waits in Backlog until the orchestrator or the user starts it. Either way the original card goes
  to Backlog as `BLOCKED: …`.
- **Only a hold stops a PASS from landing.** The hold is answered by the team kit's `runoffs` feature;
  `kanban task release-hold` is the human way out.

## Picking a kit for a new project

Every path that creates or first adds a project asks which kit it uses, with `default` preselected:

- the browser's Add Project dialog (Open folder, Clone from URL, New project): a "Routing kit" picker with `default`,
  `team`, then the user kits, each with its description and its four role models (dev, qa, plan, fallback, from the
  resolved kit, so user kits show the same way; tRPC `projects.kits`, `src/kits/kit-choices.ts`). With `team` a
  "Models" select follows: a preset (`cloud`, `cline`, `lemonade`, each showing its description and four roles) or
  "custom", which turns the four roles into editable rows (agent, provider, model; dev and QA agents required);
- `kanban project create|add <path> --kit <name>` (default `default`); for `team` also `--preset <name>`, or
  `--custom --set roles.dev.agent=<agent> --set roles.qa.agent=<agent> [--set roles.<role>.provider|model=…]`.
  Without `--kit` the CLI shows the same list as a numbered prompt and, after `team`, asks for the preset (a custom
  team is given with flags), but only when stdin is a terminal; anything else (a script, a pipe, an agent) gets
  `default` without being asked, so nothing blocks.

Both say that **the fallback starts without asking**: on `team` a paid fallback model runs and costs without
approval. If that cost worries you, don't pick a paid fallback model (a preset with a free one, or a custom team).

The choice is checked before anything is created, cloned or registered: an unknown, renamed or invalid kit, a
preset on a kit other than `team`, `team` without a preset or `--custom`, and a custom team without its dev and QA
agents are refused with the reason. The choice is applied through `kanban kit apply`'s code (`src/kits/apply-kit.ts`: its key
checks and the settings history), never a second writer of `workspaces.<id>.kit`; `default` writes no kit entry, as
before. A project that is already added (or already has a config entry) keeps its kit: the dialog's Open folder and
`project add` leave it alone, and `project add --kit` says how to change it. The landing mode stays `off` unless
`project add --landing` sets it; a kit that recommends another landing mode says so in the result. Only the user adds
projects: project create/add is refused to every agent session, so agents never pick a kit this way.

## Resolution

A key's value comes from the first of these that has it:

1. The workspace's project settings: `kit.overrides` in config.json (dotted key → value, e.g. `"qa.blurb"`).
2. The preset (`kit.preset`, only with the `team` kit): its models.
3. The named kit.
4. The `default` kit.

A workspace's kit is stored as `workspaces.<id>.kit = { name, preset, overrides }`. `preset` is a preset's name or
`null`: `team` with `null` is a custom team, and every other kit has `null` (a preset on another kit is an error).
A preset's and the team kit's `recommends.settings` add up (by `key`, the preset wins on the same key), so the
lemonade preset's turn detector setting comes on top of the team's recovery settings.

A role names a `model` or a `tier`, never both: a layer that sets one drops the other's value from the layers
below, so a project's `roles.dev.model` replaces the kit's `roles.dev.tier` (its provider then comes from
`roles.dev.provider`, else the agent's default).

Arrays are replaced, never merged: overriding `qa.routes` replaces the whole list. Nothing is inherited from another
workspace, and there is no top-level routing key a project could pick up by accident. A workspace without a `kit`
entry gets `default`. If the named kit or preset is missing, or its overrides don't validate, the workspace falls
back to `default` and `kanban doctor` / `kanban kit show` report it.

```jsonc
// <home>/config.json
"workspaces": {
  "notes":       { "landing": { "mode": "qa" }, "kit": { "name": "team", "preset": "lemonade", "overrides": { "qa.promptNotes.dbSetup": "npx prisma db push" } } },
  "bar":         { "landing": { "mode": "qa" }, "kit": { "name": "team", "preset": null, "overrides": { "roles.dev.agent": "codex", "roles.qa.agent": "claude" } } },  // custom team
  "foo":         { "landing": { "mode": "qa" }, "kit": { "name": "team-foo", "overrides": { "qa.blurb": "Project: Pawsome…" } } },  // user kit
  "kanban-2uge": { "landing": { "mode": "off" } }   // no kit: default
}
```

`kanban kit show --project <ws>` prints the team definition (the kit and its preset, or custom; each role's
effective agent and model with its source; the fallback, its triggers and its approval, on `team` "none, the sibling
starts at once"), the project
settings with their history, and every resolved value with its source (`project`, `preset:<name>`, the kit's name,
or `default`). `kanban kit show team --preset <name>` (or `--custom`) shows a kit without a project, and
`kanban kit presets` lists the presets with their four roles. The pipeline worker reads the kit and its overrides
on every evaluation, so a kit change needs no restart.

The landing mode is a core setting ([CONFIG.md](CONFIG.md)), not a kit key. Applying a kit never changes it.
`kanban kit apply team --preset cloud --project foo --landing qa` sets both in one step on purpose.

### Renamed kits

`team-cloud`, `team-local` and `team-cline` were replaced on 2026-10-12 (`src/kits/renamed-kits.ts`):

| Old kit | Now |
|---|---|
| `team-cloud` | `team` + preset `cloud` |
| `team-local` | `team` + preset `lemonade` |
| `team-cline` | `team` + preset `cline` |

The old names keep working where they are stored and nowhere else: a `workspaces.<id>.kit` that names one runs on
`team` with its preset at once (every reader sees the new pair; config.json keeps the old name until it is
rewritten), `kanban doctor` warns, and `--fix` (and `kanban config import-kit`) rewrites the entry to
`{ "name": "team", "preset": … }` with its overrides unchanged. `kanban kit apply team-local`, `kit create --from
team-local` and the other commands that take a kit name answer `kit "team-local" is now team (lemonade)
(2026-10-12); use team --preset lemonade`.
`kit list` lists only `team` and its presets, and no user kit may take an old name. A user kit made `--from` an old
kit earlier is a full copy and needs nothing. The earlier rename of the same day (`team` → `team-cloud`) is gone:
`team` is the new kit's name, so a stored `team` is the team kit (without a preset, a custom team).

What changed for a project on an old kit is only the workflow the copies differed in, now fixed in `team`
([below](#the-team-kit)): on `team-local` (notes) and `team-cline` the outage takeover and the `runoffs` feature are
now on; on `team-cloud` the per-vendor QA route and its `drive` rule are gone (QA is `roles.qa` for every dev card).
Project settings that are project facts keep applying unchanged.

### Existing cards after a kit change

A kit's `devAssignment` is stored on a card when it is created, so cards made before `kanban kit apply` (or before
`roles.dev` changed) keep their old agent. To move the Backlog onto the current kit:

```sh
kanban task reassign --column backlog --project-path /projects/<name> --dry-run   # what each card would get
kanban task reassign --column backlog --project-path /projects/<name>
kanban task reassign --task-id <id> [<id>…]                                       # or only some cards
```

It asks the kit's current `devAssignment` again, as if each card were created now (`decideDevReassignment()` in
`src/kits/dev-assignment.ts`), and prints a status per card:

- `reassigned`: the card named no agent and no model, or was still exactly on the kit's last logged `applied`
  assignment (an older kit's pick), and now has the current proposal. A reasoning effort of its own is kept.
- `explicit`: the card names another agent or model, the user's pick; it is kept. Clear it first
  (`task update --agent-id default --provider default --model default`) to hand it to the kit.
- `unchanged` (already on the proposal), `shadow` (`pipeline.shadow` on: logged, not applied), `no_proposal`
  (the kit has no dev assignment, e.g. `default`).
- `not_backlog`, `started` (a Backlog card that has a session, so it ran before), `not_dev`
  (`resolveCardRole()`): never changed. A started card switches model only through `kanban task restart-fresh`.

The decision runs on the board read under the workspace lock, so a card started meanwhile is never changed. Each
`reassigned` or `shadow` card gets a `dev-assignment.jsonl` line like a creation, with `source: "reassign"` and
the card's `previous` agent; `--dry-run` changes and logs nothing. After `task update` cleared a Backlog dev card's
agent on a kit with a dev assignment, the CLI prints the `reassign` command for it on stderr.

## Schema

`"kit": 1` is the schema version. The schema is strict: an unknown key is an error at `kanban kit apply` (and in a
user kit file), never a silent no-op. A missing key means "no answer", so the `default` kit's value applies. The
`team` column is `kits/team.json`; where it names no value (the role models, tiers, the price region) the
[preset](#presets) or the project gives it.

| Key | Type | Used for | `default` | `team` |
|---|---|---|---|---|
| `kit` | `1` | schema version | `1` | `1` |
| `name` | lowercase `[a-z0-9_-]`, the file name | | `default` | `team` |
| `description` | text | `kanban kit list` | | |
| `roles.dev` | `{ agent?, provider?, model? \| tier?, note? }` | `devAssignment`: the agent and model of new dev cards (model needs agent) | none (→ `null`) | from the preset or project |
| `roles.qa` | same | `qaPolicy`: the QA agent and model when no route matches. No model = the agent's own default (Codex: `~/.codex/config.toml`) | none | from the preset or project |
| `roles.plan` | same | `planAssignment`: the planner; no agent = the selected agent, no model = the agent's own default | none | from the preset or project |
| `roles.fallback` | same | the model a dev card's task falls back to (`fallback.on`). No agent = the dev role's agent, else the card's; a tier needs the `tiers` feature | none | from the preset or project |
| `qa.enabled` | boolean | `qaPolicy`: does a dev card get QA at all | `false` | `true` |
| `qa.skip.roles` | roles | `qaPolicy`: roles that never get QA | `qa`, `triage`, `calibration`, `plan` | same |
| `qa.skip.effectiveAgents` | agent ids | `qaPolicy`: effective agents whose cards never get QA | `[]` | `[]` |
| `qa.routes[]` | `{ devModel, agent, model?, provider?, rules?, why? }` | `qaPolicy`: `devModel` is a regex on the dev card's effective model; first match wins (user kits) | `[]` | `[]`: `roles.qa` for every dev card |
| `qa.requireDifferentVendor` | boolean | `qaPolicy`: refuse (answer `none`) a route whose QA model has the dev model's vendor | `false` | `true` |
| `qa.rules.<name>` | text | QA prompt steps a route names in `rules`; `{outbox}` is filled in | `{}` | `drive` ("drive the changed path"), reached only through a route, and `team` has none |
| `qa.blurb` | text | the "Project: …" line of the QA prompt | `""` | `""` (foo overrides it) |
| `qa.promptNotes.{screenshotFallback,knownBaseIssues,dbSetup}` | text | project sentences in the QA prompt | `""` | `""` (foo overrides `dbSetup`) |
| `qa.serversScript` | path or null | the script QA uses to start the project's servers in its scratch copy | `null` | `null` |
| `qa.preview` | `{ pidFile, start, stop }` or null | the preview QA screenshots go through. Started before a QA card when down, stopped after `pipeline.qa.previewIdleMin` idle minutes, only if the pid is still the one the QA gate started | `null` | `null` |
| `plan.enabled` | boolean | `planAssignment`: does the project make plan cards at all | `false` | `true` |
| `plan.startInPlanMode` | boolean | the plan card starts in the agent's plan mode | `false` | `true` |
| `plan.rules.<name>` | text | project rules added to the plan prompt, in key order | `{}` | `{}` |
| `plan.candidates[]` | `{ agent, model?, note? }` | agents and models a later runoff or calibration compares; never read for routing | `[]` | from the preset |
| `plan.note` | text | | | from the preset |
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
| `checks.envFile`, `checks.databaseUrlVar`, `checks.setup`, `checks.teardown` | path, variable name, shell commands | the scripted checks' environment ([Project settings](#the-scripted-checks-environment-checks)) | unset | unset |
| `worktrees.symlinkIgnored.include`, `worktrees.symlinkIgnored.exclude` | glob lists | which git-ignored paths of the main checkout task worktrees link ([below](#task-worktrees-ignored-paths-worktreessymlinkignored)) | unset (the default excludes) | unset |
| `features[]` | `scoreboard`, `bench`, `runoffs`, `calibration`, `tiers` | built-in team features that run for the project | `[]` | all five |
| `tiers.<name>[]` | `{ provider?, model, default?, note? }` | `roles.<role>.tier`, `kanban bench tiers`, `bench runoff create --tier` | | from the preset (cline, lemonade: `dev`, `qa`, `senior`; cloud: none) |
| `dropped[]` | `{ provider?, model, at?, why? }` | a kit's own models no tier lookup returns, on any provider | | none |
| `tierRules`, `tierNotes` | text per tier | shown by `kanban bench tiers` | | from the preset |
| `prices.region` | AWS region | the `bench` feature's daily AWS price check | | from the preset (cloud: `us-west-2`) |
| `prices.autoSync` | boolean | turns that check off for a user kit; the check proposes only metered models, so a kit with none skips it anyway | | unset |
| `recommends.landingMode` | landing mode | shown by `kanban kit show/apply`, **never applied** without `--landing` | | `qa` |
| `recommends.settings[]` | `{ key, op?, value, why }` | core settings the kit's routing needs: `key` is a dotted config.json key (`workspace.` = the project's own `workspaces.<id>` entry), `op` `equals` (default), `atMost` or `atLeast`. Shown by `kanban kit show/apply` and warned about by `kanban doctor` when unmet, **never applied** | | recovery on (two; the lemonade preset adds the turn detector) |

**A preset** (`kits/presets/<name>.json`, `kitPresetSchema` in `src/kits/kit-schema.ts`, `"preset": 1`) is strict
too and has only these keys: `preset`, `name`, `description`, `roles.<role>.agent|provider|model|tier|note`,
`tiers`, `tierRules`, `tierNotes`, `dropped`, `plan.candidates`, `plan.note`, `prices.region` and
`recommends.settings` (provider facts). Any other key (onFail, fallback, QA rules or routes, features, …) fails to
parse, so no preset can change the workflow. A preset must resolve over `team`, so a role's `tier` names one of the
preset's own tiers.

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
  `plan`, `fallback`; an unknown role, or one the kit doesn't define, is an error). The fallback role is also the
  escalation and outage takeover target, so `roles.fallback.*` sets those;
- **every other model the kit names** (since 2026-10-12, `PROJECT_MODEL_KEYS` in `src/kits/project-settings.ts`),
  only for a tier or list entry the kit has (a project changes the kit's entries, it never adds a tier or an entry;
  `<i>` is the entry's index, as `kanban kit show --json` lists them):

  | Key | What |
  |---|---|
  | `tiers.<tier>` | the tier's whole list of model picks (`[{ provider?, model, default?, note? }]`) |
  | `tiers.<tier>.<i>.provider\|model\|default` | one pick of the tier, or which one is the default |
  | `qa.routes.<i>.agent\|provider\|model` | a QA route's reviewer (its `devModel`, `rules` and `why` stay the kit's) |
  | `plan.candidates.<i>.agent\|model\|model.provider\|model.model\|model.tier` | a plan candidate |
  | `onFail.runoff.models.<i>.agent\|provider\|model` | a runoff racer (which racers there are stays the kit's) |

  As in a role, a candidate's `model.model` drops the kit's `model.tier` and the other way round;
- **project facts**: `qa.blurb`, `qa.promptNotes.{dbSetup,knownBaseIssues,screenshotFallback}`, `qa.serversScript`,
  `qa.preview`, `land.postLand`, `plan.rules`, `checks.{envFile,databaseUrlVar,setup,teardown}` (the scripted
  checks' environment, [below](#the-scripted-checks-environment-checks)), `worktrees.symlinkIgnored.{include,exclude}`
  ([task worktrees' ignored paths](#task-worktrees-ignored-paths-worktreessymlinkignored)) (`PROJECT_FACT_KEYS` in
  `src/kits/project-settings.ts`).

Everything else is the flow and is refused with a message: `onFail.*` (but the runoff racers' models), `fallback.*`
(the triggers and the approval rule), `qa.enabled`, `qa.requireDifferentVendor`, `qa.skip`, `qa.routes` as a list
and a route's `devModel`/`rules`, `qa.rules`, `tiers` as a whole (which tiers exist), a tier entry's `note`,
`tierRules`, `tierNotes`, `dropped`, `features`, `plan.enabled`, `recommends`, `description`,
`roles.<role>.note`. A project gets another flow by using another kit (`kanban kit apply`, [Switching a project's
kit](#switching-a-projects-kit)); kits themselves are made and edited only by the user.

On `team` that leaves a project the role models (on a preset they override some of its roles; on a custom team they
are the models), the tier picks where its preset has tiers (cline, lemonade; cloud and a custom team have none), the
plan candidates its preset lists, and the project facts. Every workflow key is refused, and so is the preset itself:
it changes with `kanban kit apply team --preset <name>`, never as an override (`kit`, `name` and `preset` identify
the kit).

```sh
kanban kit set roles.fallback.model us.moonshotai.kimi-k3 --project /projects/foo
kanban kit set roles.fallback.agent codex --project /projects/foo
kanban kit set qa.promptNotes.dbSetup "npx prisma migrate deploy" --project /projects/foo
kanban kit set land.postLand '[{"paths":"^prisma/","run":"npx prisma generate"}]' --project /projects/foo
kanban kit unset roles.dev.model --project /projects/foo       # the preset's (or kit's) dev model again
kanban kit unset roles.fallback --project /projects/foo        # every field of the role
kanban kit set tiers.dev.0.model Qwen3.8-27B-GGUF-UD-Q4_K_XL --project /projects/notes   # one tier pick (lemonade preset)
kanban kit set qa.routes.0.model us.amazon.nova-2-lite-v1:0 --project /projects/foo # a QA route's reviewer (a user kit with routes)
kanban kit unset qa.routes.0 --project /projects/foo           # every setting of that route entry
kanban kit set onFail.reworkRounds 5 --project /projects/notes # refused: part of the team definition (kit team)
kanban kit set roles.dev.model gpt-9 --project /projects/foo          # any model; for Cline, doctor warns if models.json doesn't list it
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

The CLI also refuses `kit set|unset|apply` in a card session before it asks the server (`ORCHESTRATOR_OR_USER_COMMANDS`),
and every refusal is logged to `data/<ws>/isolation.jsonl`.

### Switching a project's kit

`kanban kit apply <kit> --project <path>` points the project at another kit (since 2026-10-12 the project's own
orchestrator may run it too, not only the user). It goes through the running server (tRPC `kit.applyKit`), with the
same caller rule as `kit set` (the table above): the user and the project's own orchestrator, never another
project's orchestrator or a card. Without a running server only a process without a session credential applies it
in-process (that is the user). Every change is logged to `kit-settings-history.jsonl` (`via: "kit apply"`, a
`(kit)` line for the switch itself).

A switch keeps the project's settings that still fit the new kit and drops the others, listed in the output
(`dropped`, with why): a role, tier or list entry the new kit doesn't have, or a value that doesn't resolve on it
(`roles.dev.tier dev` on the `cloud` preset, which has no tiers). Team keys stored before the split stay, as before. The checks a
switch did before stay: an unknown kit, `--set` takes only project settings, the whole resolution must validate.
`--landing` (the core landing mode) is the user's and the project's own orchestrator's (user, 2026-10-13, issue
#42); a change is logged as a `(landing)` line with who made it. `--unset` of a stored team key stays the user's:
the orchestrator is refused it.

`team` needs its models: `--preset <name>`, or `--custom` with at least `--set roles.dev.agent=<agent>` and
`--set roles.qa.agent=<agent>` (given now or already stored; without a QA agent no card would be QA'd). A project
already on `team` keeps its preset when neither is given. A change of preset is a switch too: a stored tier pick the
new preset has no tier for is dropped and listed, role settings always fit. The history gets a `(preset)` line.
Old kit names are answered with the new form ([Renamed kits](#renamed-kits)).

```sh
kanban kit presets                                                  # the presets and their four roles
kanban kit apply team --preset lemonade --project /projects/foo --dry-run   # what changes, what is dropped
kanban kit apply team --preset lemonade --project /projects/foo
kanban kit apply team --custom --project /projects/foo \
  --set roles.dev.agent=codex --set roles.dev.provider=bedrock --set roles.dev.model=us.openai.gpt-6.1-sol \
  --set roles.qa.agent=claude \
  --set roles.fallback.agent=codex --set roles.fallback.provider=bedrock --set roles.fallback.model=us.moonshotai.kimi-k3
```

**Where.** Project settings stay in config.json (`workspaces.<id>.kit.overrides`), not in the project repo: a card
can edit and land repo files, which is the problem this avoids. They are the resolver's existing input, written
atomically under the config lock, and moved with the rest of `workspaces.<id>` by `kanban project rename-id`.
Every change is appended to `data/<ws>/kit-settings-history.jsonl` (one JSON line: `at`, `kitName`, `key`, `from`,
`to`, `by` = user / orchestrator with its session id / a user-run command, `via` = `kit set`, `kit unset`,
`kit apply`, `kit migrate-overrides` or `kit edit` (the user changed the kit itself, [Writing a user kit](#writing-a-user-kit))). `kanban kit show --project` prints its path and the last change.

### The scripted checks' environment (`checks.*`)

The scripted checks run on a clean export of the snapshot (WORKFLOW.md "Scripted checks"), which has none of the
card's git-ignored files. A project whose tests need its `.env` (a database URL, a session secret) says so with
these facts; without them the checks run exactly as before (issue #16: notes' tests failed there on every run with
"Environment variable not found: DATABASE_URL").

| Key | Value | What the checks do |
|---|---|---|
| `checks.envFile` | path relative to the project (no `..`) | copy that file from the **card's worktree** into the export (same path, mode 600) and load its variables into every step (install, setup, scripts, teardown). `KANBAN_*` and the secret token names (`SECRET_ENV_NAMES`) in it are not loaded, and the checker's own variables (`CI`, the worker caps, the npmrc) win. A file that is missing, a symlink out of the worktree, or unparseable makes the run a checker ERROR. |
| `checks.databaseUrlVar` | a variable of the env file (`DATABASE_URL`) | give the run **its own database**: the URL's database name is replaced by `CHECKS_DB` = `checks_<workspace>_<card>` (lower case, `[a-z0-9_]`, at most 63 characters), in the step env and in the copied file, so the checks never touch the card's working database. `CHECKS_SOURCE_DATABASE_URL` is the card's URL, for a setup or teardown that must connect somewhere else to create or drop the run's database. Needs `checks.envFile` and a URL with a host and a database name. |
| `checks.setup` | shell command | run in the export after the install and `prisma generate`, before the scripts. A failure is a harness problem: the scripts are skipped and the snapshot is checked again on the next submission. |
| `checks.teardown` | shell command | run in the export after the scripts whenever the install succeeded, whatever happened then (a failed setup, a run stopped for a newer snapshot). Shown in the report; never part of the verdict. |

Kanban speaks no database protocol: the setup creates the run's database and its schema (the project's own way, as in
`qa.promptNotes.dbSetup`), the teardown drops it. One statement per `prisma db execute`: Postgres refuses
`CREATE DATABASE` inside a multi-statement script.
The name is the card's, not the snapshot's: checks run one at a time, so a database a crashed run left behind is the
same card's next one, and a setup that drops it first (`DROP DATABASE IF EXISTS`) starts clean.

The env file's values are secrets. Every step's output is redacted before it is written to its log
(`.checks/<step>.log`), stored in pipeline-state, the QA log or the QA prompt (values of 8 characters or more that
aren't a number or a boolean, and any URL password); the copied file is deleted when the run ends, so neither QA
nor a person reading the export finds it. Keep secrets out of the commands themselves: they are kit facts, shown by
`kanban kit show` and logged in `kit-settings-history.jsonl`. Code: `src/pipeline/checks-project-env.ts`.

```sh
# notes: Prisma on the pod's Postgres, one database per card in the worktree's .env
kanban kit set checks.envFile .env --project /projects/notes
kanban kit set checks.databaseUrlVar DATABASE_URL --project /projects/notes
kanban kit set checks.setup 'echo "DROP DATABASE IF EXISTS \"$CHECKS_DB\"" | npx prisma db execute --url "$CHECKS_SOURCE_DATABASE_URL" --stdin && echo "CREATE DATABASE \"$CHECKS_DB\"" | npx prisma db execute --url "$CHECKS_SOURCE_DATABASE_URL" --stdin && npx prisma db push --skip-generate' --project /projects/notes
kanban kit set checks.teardown 'echo "DROP DATABASE IF EXISTS \"$CHECKS_DB\"" | npx prisma db execute --url "$CHECKS_SOURCE_DATABASE_URL" --stdin' --project /projects/notes
```

### Task worktrees' ignored paths (`worktrees.symlinkIgnored`)

A new task worktree has none of the main checkout's git-ignored files, so Kanban links them in: each ignored path
(a top-level one, as `git ls-files --others --ignored --directory` lists it) becomes a symlink to the checkout's
copy. A link is shared by the checkout and every card, so only what cards *read* is safe to link. Until issue #19
(2026-10-09) every ignored path was linked, and foo's parallel cards shared `prisma/dev.db`, `prisma/test.db`,
`.next` and `server/dist`: one card's tests or build wrote everybody's.

Now every ignored path is linked **unless** it matches the default exclude list or the project's `exclude`:

| Default exclude | Why |
|---|---|
| `*.db`, `*.db3`, `*.sqlite*`, `*-journal`, `*-wal`, `*-shm` | databases (SQLite and its journal files): cards would share one dev/test database |
| `.next`, `next-env.d.ts`, `.nuxt`, `.output`, `.svelte-kit`, `dist`, `build`, `out`, `target`, `*.tsbuildinfo`, `.preview` | build output: a card's build would overwrite the main checkout's and every other card's |
| `.turbo`, `.cache`, `.parcel-cache`, `.vite`, `.eslintcache`, `__pycache__`, `.pytest_cache` | caches the tools write while a card works |
| `coverage`, `.nyc_output`, `test-results`, `playwright-report` | test output |
| `*.log`, `logs`, `tmp`, `.tmp` | logs and scratch files |
| `node_modules`, `bower_components`, `.venv`, `venv` | installed packages: an install in a card deletes the main checkout's packages through the link |

Installed packages were linked until 2026-10-10, and that emptied foo's main checkout: `npm ci` in a card first
deletes every entry of its `node_modules`, *through* the link, and only then replaces the link with a directory of
its own, so the card's install looks fine while the main checkout's `tools/preview/node_modules` is left empty (25
cards that day, each from its own `npm ci --prefix tools/preview`). Cards install their own packages now. A project
can `include` `node_modules` again only if no card ever installs there. Removing a worktree never deletes through a
link: Kanban unlinks its own links first and deletes the rest without following any symlink.

Still linked by default, because cards read them: `.env*` files and other local config (`.cline` is made per card
before a Cline launch, `ensureCardOwnedClineDir`).
Kanban's own rules hold whatever the project says: `.git`, `.DS_Store` and the like are never linked, and a
Next/Turbopack package's `node_modules` isn't either (Turbopack refuses a symlinked `node_modules` outside the
project root).

| Key | Value | Means |
|---|---|---|
| `worktrees.symlinkIgnored.exclude` | glob list | not linked either (on top of the defaults) |
| `worktrees.symlinkIgnored.include` | glob list | linked even though a default excludes it; `exclude` wins over `include` |

A glob without `/` matches any segment of the path (`dist` matches `server/dist`), one with `/` the path from the
project root (`prisma/*.db`); `*` and `?` stay within a segment, `**` crosses them. A path also matches when one of
its parent directories does. A wholly ignored directory is one path: `data/` is linked or not as a whole, so a
database inside it needs `exclude: ["data"]`.

**`checks.envFile` is copied, not linked.** The scripted checks copy that file from the card's worktree and refuse
a symlink out of it, and a per-card database (`checks.databaseUrlVar`) means the card edits its own copy. So a new
worktree gets a copy of the main checkout's file (when the worktree has none), and an ignored directory holding it is
not linked.

**Worktrees made before the rule.** New worktrees follow the rule. A live worktree keeps the links it has, because a
running card may be using them; the managed `info/exclude` block keeps listing them, so they never show up in a
snapshot. `kanban doctor` warns, per project, about every link in a live task worktree that the rule would not create
(with its path and why). The user replaces them with `kanban project unlink-ignored <project>`: a linked file
becomes a copy (a database keeps its data, now the card's own), a directory an empty one (a build output or cache is
rebuilt), a dangling link goes. A worktree with any process in it (the card's agent, a dev server, a test run) is
skipped; `--dry-run` lists what would change. Code: `src/workspace/worktree-link-rule.ts`,
`src/workspace/worktree-link-audit.ts`.

```sh
kanban kit set worktrees.symlinkIgnored.exclude '["uploads"]' --project /projects/foo
kanban kit set worktrees.symlinkIgnored.include '[".cache"]' --project /projects/foo
kanban project unlink-ignored /projects/foo --dry-run
```

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
`Qwen` → `qwen`, `Gemma` → `google`, `DeepSeek` → `deepseek`, `Muse` → `meta`, `Laguna` → `poolside`), named like the Bedrock vendors so a local and a
Bedrock model of one family count as one vendor. An id it can't place gives no vendor, and the rule doesn't refuse.

A tier lookup returns the tier's `default` entry, else its first usable one, and skips the kit's `dropped` models
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

`kits/team.json`: the dev-team workflow, the same for every project on it, with no models (user request
2026-10-12). Its four roles (dev, QA, plan, fallback) are slots with a note each; the models come from a
[preset](#presets) or, for a [custom team](#custom-team), from the project's own role settings. The workflow goes
back to the routing that ran the `foo` project under the legacy kit; P4-T1 checked parity against the legacy kit's
live config (`test/runtime/kits/team-parity.test.ts`, `team-qa-routing.test.ts`, `team-qa-prompt.test.ts`).

- **QA:** every dev card, by `roles.qa` (no `qa.routes`). The QA vendor must differ from the dev vendor
  (`qa.requireDifferentVendor`): a card whose effective model is from the QA model's vendor gets no QA
  (`kit show` warns). QA, TRIAGE, calibration and plan cards are never QA'd.
- **Plan:** plan cards on `roles.plan`, starting in the agent's plan mode.
- **FAIL:** same-model rework for 3 rounds (conflicts too, with rebase notes), then the **fallback**.
- **Fallback:** `roles.fallback` takes the task over on a sibling card after 3 failed QA rounds, a QA stall, an
  unchanged rework, a conflict its reworks didn't fix, or a provider outage hold that lasted
  `pipeline.recovery.outage.maxMin`. It **starts at once, without approval** (`fallback.requireApproval: false`),
  whatever the model costs. A fallback sibling that fails in turn goes to the orchestrator, never to another sibling
  (`refuseTakeover()` in `src/pipeline/rework.ts`), so the orchestrator is the last resort.
- **Features:** `scoreboard`, `bench`, `runoffs`, `calibration`, `tiers` ([below](#the-team-features)).
- **Recommends** landing `qa`, and the settings `pipeline.recovery.mode = on` and the project's `recovery.enabled`
  (default `true`), so provider errors are retried, outages held and probed, stalled turns nudged and account answers
  escalated (`recommends.settings`, never applied).

The built-in team kits before 2026-10-12 differed in a few workflow keys. `team` has one fixed answer for each, and
neither a preset nor a project can change it:

| Key | Before | In `team` |
|---|---|---|
| `fallback.requireApproval` | `false` in all three, but per kit | `false`: the fallback starts without asking, for every preset and custom team, paid or free. A paid fallback model runs and costs without approval; if that worries you, don't pick a paid fallback |
| `fallback.on.outage` | on in team-cloud only | on: after `maxMin` the fallback sibling starts. On a provider whose outage takes every model down (Lemonade, ClinePass) the sibling waits on the same outage and then goes to the orchestrator, since a sibling is never handed on again. The cost is one extra Backlog card per outage |
| `runoffs` feature | team-cloud only | on: it acts only while a runoff group exists (`onFail.runoff` is `null`; groups come from `kanban bench runoff create`) |
| `qa.routes` | team-cloud: OpenAI-built cards → Cline on Haiku 4.5 with the `drive` rule | none: `roles.qa` for every dev card. `qa.routes` stays in the schema for user kits; `team` keeps the `drive` rule text so imported legacy routes that name it still validate, but nothing in `team` reaches it |
| recovery `recommends.settings` | team-local and team-cline only | in `team`. Lemonade's turn detector setting stays in the lemonade preset (a provider fact) |
| `prices.autoSync` | team-cloud on, the others off | unset: the daily price check proposes only metered models (`listKitModels` in `src/kits/team/bench/price-sync-job.ts`), so it runs for cloud and has nothing to do for cline and lemonade |

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

## Presets

A preset (`kits/presets/<name>.json`, [schema](#schema)) names the `team` kit's models: each role's agent,
provider and model (or a tier of its own), tier lists with their notes, plan candidates, the price region and the
core settings its provider needs. It holds no workflow key. `kanban kit presets` lists them with their four roles,
`kanban kit show team --preset <name>` shows one resolved. Their models must be in Cline's models.json record where
a role is on Cline (doctor warns otherwise).

| Preset | Dev | QA | Plan | Fallback |
|---|---|---|---|---|
| `cloud` | Codex, `bedrock` / `us.openai.gpt-6.1-sol` | Cline, `bedrock` / `us.anthropic.claude-haiku-5-5` | Cline, `bedrock` / `us.anthropic.claude-opus-5-5` | Codex, `bedrock` / `us.moonshotai.kimi-k3` |
| `cline` | Cline, `cline-pass/glm-5.3` | Cline, `cline-pass/qwen3.8-max` | Cline, `cline-pass/minimax-m3` | Cline, `cline-pass/kimi-k3` |
| `lemonade` | Cline, `Qwen3.8-27B-GGUF-UD-Q4_K_XL` | Cline, `Muse-Glimmer-30B-GGUF-Q4_K_M` | Cline, the QA model | Cline, `Qwen3-Coder-30B-A3B-Instruct-GGUF-Q4_K_M` |

A project on a preset can still set its own model for any role (`kanban kit set roles.<role>.*`, the value's
source is then `project` instead of `preset:<name>`), and a tier pick where the preset has tiers.

### `cloud`

`kits/presets/cloud.json`: AWS Bedrock, paid per token. Every role names its model directly; there are no tiers.

- **Dev:** GPT-6.1 Sol on Codex (user 2026-10-12; it won the tier-3 multi-region runoff and both mai-vs-sol runoffs
  on foo).
- **QA:** Claude Haiku 5.5 on Cline, another vendor (anthropic) than the dev model (openai) and the fallback
  (moonshotai), so the fallback sibling is still reviewed by Haiku.
- **Plan:** Claude Opus 5.5 on Cline, in its plan mode (`--plan`).
- **Fallback:** Kimi K3 on Codex. It is paid and starts without approval.
- **Prices:** `prices.region: us-west-2` for the daily AWS price check, which runs for this preset's models.

### `cline`

`kits/presets/cline.json`: ClinePass, Cline's subscription provider, through the Cline CLI with provider
`cline-pass` (model ids `cline-pass/<model>`, $0 per run). Every role is `cline + cline-pass`
(`test/runtime/kits/cline-preset.test.ts` checks every model and agent). All four models passed `kanban models vet`
for dev and QA (2026-10-12, cline 3.0.70; none was vetted for plan, [MODELS.md](MODELS.md#clinepass-cline-pass)). The
key must be stored with `kanban setup-provider cline-pass` ([cline-pass-auth.md](../fork/cline-pass-auth.md)).

| Role | Model | Vendor (`getModelVendor()`) |
|---|---|---|
| Dev (`roles.dev`: tier `dev`) | `cline-pass/glm-5.3` | zai |
| QA (`roles.qa`) | `cline-pass/qwen3.8-max` | qwen |
| Plan cards (`roles.plan`, Cline `--plan`) | `cline-pass/minimax-m3` | minimax |
| Fallback dev model (`roles.fallback`: tier `senior`) | `cline-pass/kimi-k3` (ClinePass: "will consume usage faster than others") | moonshotai |

- The vendor is read from the id after `cline-pass/`, so the dev and the fallback models are both reviewed by
  qwen3.8-max. The other ClinePass models that passed the vet are candidates in `tiers` (`mimo-v2.6-pro`,
  `mimo-v2.6-flash`, `deepseek-v4.1-flash`, `muse-spark-1.3-contributor` for dev; `minimax-m3`, `mimo-v2.6-pro`
  for QA).
- **Outage:** the outage takeover starts the kimi-k3 sibling after `maxMin`; it waits on the same subscription's
  outage and then goes to the orchestrator. ClinePass's account answers (no subscription, an organization account)
  escalate at once, and its usage-limit answer gets the provider retries and then escalates (provider errors,
  MODELS.md).
- **QA slots:** ClinePass is a cloud provider, so its QA cards take a cloud QA slot (`pipeline.qa.slots`), unlike
  Lemonade's.
- **Runoffs:** a runoff races sibling cards on several models for the same task, which multiplies the
  subscription's usage for one card; nothing starts one unless you create a group.
- **Costs:** a turn on provider `cline-pass` costs 0 whatever the model id (`SUBSCRIPTION_PROVIDER_IDS` in
  `src/kits/team/bench/prices.ts`), so the scoreboard and `kanban bench metrics` show `$0.00`, and the price check
  has nothing to propose.

```sh
kanban kit apply team --preset cline --project /projects/<name> --landing qa --dry-run
kanban kit apply team --preset cline --project /projects/<name> --landing qa
kanban kit show --project /projects/<name>
kanban doctor /projects/<name>     # warns about unmet settings and models Cline's models.json doesn't list
```

### `lemonade`

`kits/presets/lemonade.json` (the models of the former `team-local` kit): the local Lemonade server
(http://localhost:13305/api/v1, OpenAI compatible) through the Cline CLI with provider `lemonade`. No paid or cloud
provider appears anywhere in it (`test/runtime/kits/lemonade-preset.test.ts` checks every model and agent).
Qwen3.8-27B passed `kanban models vet` for dev and QA (2026-10-13, at 65536 context), Muse-Glimmer for dev and QA
(2026-10-12, cline 3.0.70) and Qwen3-Coder-30B-A3B for dev and QA (2026-10-13); none was vetted for plan. The layout is
the one the notes project found working on 2026-10-13, so notes can run on the preset without its own role settings.
`kanban bench calibrate` can still compare candidates on the project.

| Role | Model (passed `kanban models vet`) | Why |
|---|---|---|
| Dev (`roles.dev`: tier `dev`) | `Qwen3.8-27B-GGUF-UD-Q4_K_XL` | Qwen's Qwen3.8-27B: a dense 27B with vision + tool-calling + MTP, 17.2 GB, 65536 context as Lemonade loads it (vet runs `2026-10-13-dev-cline-311az`, `2026-10-13-qa-cline-bxk8v`). The dev tier's only pick |
| QA (`roles.qa`), plan cards (`roles.plan`: its own model, Cline `--plan`) | `Muse-Glimmer-30B-GGUF-Q4_K_M` | Meta's Muse Glimmer (Meta Superintelligence Lab, distilled from Muse Spark): another family (meta) than the dev and fallback models (qwen), a dense 30B with tool-calling + vision, 16.9 GB, 65536 context as Lemonade loads it (max 131072). Plans on the QA model load no fourth model (not vetted for plan). A card someone builds on Muse-Glimmer itself gets no QA (`kit show` warns) |
| Fallback dev model (`roles.fallback`: tier `senior`) | `Qwen3-Coder-30B-A3B-Instruct-GGUF-Q4_K_M` | Qwen's Qwen3-Coder, the dev model's family but not the QA model's, so its sibling is still reviewed by Muse-Glimmer. A MoE with 3B active, tool-calling, no vision, 17.4 GB, 65536 context as Lemonade loads it (max 262144). The fallback only: as a dev model in the notes project it emitted invalid JSON tool calls on Lemonade (2026-10-13) |

These are the defaults since 2026-10-13, following the notes project's working layout: Qwen3.8-27B replaced
Muse-Glimmer as the dev model, Muse-Glimmer replaced gemma-4-E4B as the QA model (gemma-4-E4B passed the QA vet,
`2026-10-13-qa-cline-khuf9`, but notes found it too small for a reliable QA reviewer) and took over plans, and
Qwen3-Coder (the fallback since it replaced Laguna-XS-2.1 that morning) left the dev tier. The dev tier lists only
Qwen3.8; the preset names no model that the pod's Lemonade doesn't have.

- **Outage:** Lemonade down (connection refused, `/health` not `ok`) is a provider outage: recovery holds the card
  and probes `/health` every `pipeline.recovery.outage.probeEveryMin` and resumes it when Lemonade is back. After
  `maxMin` the outage takeover starts the Qwen3-Coder sibling, which waits on the same server and then goes to the
  orchestrator (every model runs on the same server, so the takeover only costs one extra card). The notes project
  sees this since the switch from `team-local`, where the trigger was off.
- **Runoffs:** a runoff races sibling cards on several models at once, which one GPU can only do by swapping models
  on every request; nothing starts one unless you create a group.
- **Costs:** a turn on provider `lemonade` costs 0 whatever the model id (`LOCAL_PROVIDER_IDS` in
  `src/kits/team/bench/prices.ts`), so the scoreboard, `kanban bench metrics` and the calibration results show
  `$0.00`, not "no price", and the price check has nothing to propose.

#### One GPU: keep dev, QA and fallback loaded

The lemonade preset runs three local models at the same time: Qwen3.8 (dev), Muse-Glimmer (QA and plan) and Qwen3-Coder
(fallback).
Lemonade keeps at most `max_loaded_models` LLMs resident (`/api/v1/health` `max_models.llm`, default 1). When it is
full it evicts the least recently used one, so with one slot every dev ↔ QA switch reloads a model. Raise it to 3:

- Lemonade's container image: the env var `LEMONADE_MAX_LOADED_MODELS=3`, then restart the container;
- otherwise `lemonade config set max_loaded_models=3` (applies live and is saved in Lemonade's config.json).

Pinning (`lemonade pin`, `"pinned": true` on `/api/v1/load`) is not needed and not recommended: with enough slots
LRU keeps all three, and a full set of pinned models makes the next load fail with 409 `slots_pinned_error`.

Kanban's own limit, `models.providerCapacity.lemonade.maxLoadedModels` (default 1), must match Lemonade's:

- recovery's retries, nudges and restart resumes, and the QA gate's QA card starts, wait while In Progress cards
  hold that many other Lemonade models (for QA, In Progress cards of every project). A Lemonade QA card takes no
  cloud QA slot (`pipeline.qa.slots`) and waits for nothing else. The QA gate records the wait once per change
  ("waiting for lemonade capacity: 1/1 model(s) loaded (held by …); queued: …");
- `kanban bench calibrate` refuses a spec with more Lemonade models than that and `parallel` above it.

Above Lemonade's value, cards on different models make it reload on every request. Below it, QA cards wait for
nothing. `kanban doctor` and `kanban kit show` read `/api/v1/health` and warn about both cases, and when
`max_models.llm` is below the 3 models the preset runs. With Lemonade at 1 and Kanban at 1, work runs one model at a
time: a QA card waits until no dev card runs on Qwen3.8, and every switch still costs a model load. Not covered yet: a
card a human starts by hand, and the rework stage's sibling and resume starts.

**Memory budget** (`tierNotes.dev`): the three models must stay resident within 80 GB of the 96 GB the iGPU can
address (Ryzen AI MAX+ 395, 125 GB RAM), leaving 16 GB headroom. Weights are Lemonade's sizes (`GET /api/v1/models` `size`), at the
context the user set on every Lemonade model (2026-10-12; 2026-10-13 for Qwen3.8 and Qwen3-Coder):

| Model | Context | Weights |
|---|---|---|
| Qwen3.8-27B (UD-Q4_K_XL) | 65536 | 17.2 GB |
| Muse-Glimmer-30B (Q4_K_M) | 65536 | 16.9 GB |
| Qwen3-Coder-30B-A3B (Q4_K_M) | 65536 | 17.4 GB |
| **sum** | | **51.5 GB** |

On top come each model's KV cache at that context and its compute buffers. Their sizes are not measured yet for
these three, so check the free memory with all three loaded before raising a context. `--save-options` replaces the model's stored
options, so repeat the backend. Cline's models.json follows by itself: the server's Lemonade context sync
(`agents.cline.lemonadeContextSync`, on by default) writes the new `contextWindow`/`maxTokens` within 30 s and
before the next Cline launch. Which models are in the record is the Kanban orchestrator's (by hand, with models that
passed `kanban models vet`); `kanban setup-provider lemonade` fills in their metadata:

```sh
lemonade load Qwen3.8-27B-GGUF-UD-Q4_K_XL --ctx-size 65536 --llamacpp vulkan --save-options
kanban setup-provider lemonade    # metadata of the record's models, drops a modelsSourceUrl; doctor prints it
```

#### Settings the lemonade preset needs

The team kit and the preset list them in `recommends.settings` (merged); Kanban's Lemonade limit is checked against
Lemonade itself (above). `kanban kit show` prints each with its current value, `kanban kit apply` lists the unmet
ones, and `kanban doctor` warns for every project on the preset whose config lacks one. None is applied for you:

| Setting | Value | From | For |
|---|---|---|---|
| `agents.cline.turnDetector.mode` | `on` | the preset | Lemonade/llama.cpp ends Cline turns without the TaskComplete hook; only the turn detector in mode `on` ends them (`report` only logs) |
| `pipeline.recovery.mode` | `on` | `team` | a no-images rejection is cleared and resent (with "never read image files"), a poisoned or overflowing context is cleared and resent, a Lemonade outage is held and probed instead of escalated |
| `workspaces.<id>.recovery.enabled` | `true` (default) | `team` | the same, for this project |

The other local gotchas:

- **Images.** The dev model (Qwen3.8) and the QA model (Muse-Glimmer) read images, so the preset needs no
  `qa.promptNotes.screenshotFallback`. The fallback (Qwen3-Coder) has no vision label in Lemonade, so a fallback
  sibling that reads a screenshot gets a no-images rejection. Recovery clears and resends an image a model rejects
  (too large or no vision).
- **Context overflow.** Cline compacts at 0.9 × the `contextWindow` in its models.json, so that window must be the
  one Lemonade really loads. The server's Lemonade context sync keeps it so after a reload (`report`/`off` in
  `agents.cline.lemonadeContextSync` stop it), `kanban doctor`'s "cline lemonade models" row compares them, and
  `kanban setup-provider lemonade` (the user or the Kanban orchestrator runs it) fixes the rest of the record's metadata. Beyond that,
  recovery (mode `on`) clears an overflowed history.
- **Models.** `kanban doctor` also warns when Lemonade doesn't list a model the preset routes to, hasn't downloaded
  it, or doesn't mark it tool-calling. It reports INFO when Lemonade is down.

#### Applying it to a new project

```sh
kanban project create /projects/<name> --kit team --preset lemonade   # or: kanban project add /projects/<name> --kit team --preset lemonade --landing qa
kanban kit apply team --preset lemonade --project /projects/<name> --landing qa --dry-run   # landing qa, which the kit recommends
kanban kit apply team --preset lemonade --project /projects/<name> --landing qa
kanban task reassign --column backlog --project-path /projects/<name>   # existing Backlog cards onto the preset
kanban kit show --project /projects/<name>                # routing + "Settings this kit needs"
kanban doctor /projects/<name>                            # warns about unmet settings and missing models
```

#### Calibrating it

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
    { "key": "muse", "agent": "cline", "provider": "lemonade", "model": "Muse-Glimmer-30B-GGUF-Q4_K_M" },
    { "key": "gemma4", "agent": "cline", "provider": "lemonade", "model": "gemma-4-E4B-it-GGUF-Q4_K_M" },
    { "key": "devstral2", "agent": "cline", "provider": "lemonade", "model": "Devstral-Small-2-24B-Instruct-2512-GGUF-Q4_K_M" }
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

## Custom team

`team` without a preset (`kit: { name: "team", preset: null }`): the team workflow on the project's own models. The
project sets each role through the project settings (`roles.<role>.agent|provider|model`, [Project
settings](#project-settings)), at apply time with `--set` or later with `kanban kit set`, by the user or the project's
own orchestrator.

- **Dev and QA agents are required.** `kanban kit apply team --custom`, `project create|add --kit team --custom` and
  the browser's custom rows refuse a custom team without `roles.dev.agent` and `roles.qa.agent`, and `kanban doctor`
  warns about a stored one that lacks either: without a QA agent `qaPolicy` answers `none`, and no card would be
  QA'd. No model means the agent's own default model.
- **The fallback is optional.** Without `roles.fallback` a trigger that fires goes to the orchestrator. With one it
  starts at once, without approval, like every team: choose a free fallback model if a paid one's cost worries you.
- **No tiers.** The team kit has none, so `roles.<role>.tier` and `tiers.*` keys are refused; name models directly.
- **The vendor rule holds:** pick a QA model from another vendor than the dev and fallback models, or their cards get
  no QA (`kit show` warns).

```sh
kanban kit apply team --custom --project /projects/<name> --landing qa \
  --set roles.dev.agent=codex --set roles.qa.agent=claude --set roles.plan.agent=claude \
  --set roles.fallback.agent=codex --set roles.fallback.provider=bedrock --set roles.fallback.model=us.moonshotai.kimi-k3
kanban kit set roles.qa.model haiku --project /projects/<name>               # change one role later
kanban kit show --project /projects/<name>                                   # sources: project, team, default
```

## Writing a user kit

User kits are made and changed only by the user, with two commands (an agent session can't run either:
`USER_ONLY_COMMANDS` in `src/isolation/cli-scope.ts`; an orchestrator asks the user). Code:
`src/kits/user-kit-edit.ts`.

- `kanban kit create <name> --from <kit> [--preset <name>] [--set <key>=<value> ...] [--description <text>] [--dry-run]`
  writes `<home>/kits/<name>.json`: the `--from` kit as it resolves over `default` (with `--from team`, plus the
  `--preset`'s models), so the file is a complete, flattened copy (kits don't inherit and user kits have no presets,
  see below), with the `--set` keys applied the way the resolver applies them (a role's `model` replaces its `tier`
  and back). This is the way to a workflow of your own: the copy is a full kit, so `kit edit` can change its flow. It
  prints every key that differs from `--from`. Refused: a taken name (`default`, `team`, the old `team-cloud`,
  `team-local`, `team-cline`, an existing user kit, a refused kit file of that name), a name that isn't a file name,
  an old kit name as `--from` (answered with its new form), and a key or value the full kit schema refuses.
- `kanban kit edit <name> --set <key>=<value> ... [--unset <key> ...] [--dry-run]` changes keys of an existing
  **user** kit (a built-in kit changes only with a Kanban release: copy it with `kit create`). `--unset` removes a
  key from the file, so the `default` kit's value applies. The result is validated, the old file copied to
  `<home>/backups/kits/<name>.json.<UTC time>`, and the new one written atomically. It prints the workspaces on the
  kit: they pick the change up at once (and it names any changed key a workspace's own stored override still wins
  for).

Both take only team-definition keys: `kit` and `name` identify the kit, legacy keys (`escalate.*`, `dev.*`, ...)
have new names, and project facts (`qa.blurb`, `land.postLand`, `checks.*`, ...) are each project's
(`kanban kit set`). A value is JSON when it parses as JSON (`false`, `3`, `["a"]`), else text. Every create and
edit is logged to `<home>/data/kit-history.jsonl` (`at`, `kitName`, `key`, `from` → `to`, `by`, `via` =
`kit create` | `kit edit`); an edit also goes to the `kit-settings-history.jsonl` of each workspace on the kit
(`via: "kit edit"`), so `kanban kit show --project` shows it.

```sh
kanban kit create claude-qa --from team --preset cloud --set roles.dev.agent=claude --set onFail.reworkRounds=1 --dry-run
kanban kit apply claude-qa --project <ws> --dry-run   # then without --dry-run; --landing qa to switch landing too
kanban kit show --project <ws>                          # every value and its source; then kanban doctor <path>
```

**foo: the team workflow with three fallback triggers off.** foo ran on `team-cloud` (the built-in team kit of the
time, before that named `team`) with overrides from before the team/project split. `migrate-overrides` turned them
into project settings plus a user kit named by `--into` (its legacy `escalate.*` / `onOutage.then` keys were dropped
as redundant, since `team-cloud` already had every trigger on and no approval, so no stored trigger override was left
to shadow the kit), then the edit turned the three triggers off. The `qaFails` and `outage` triggers and everything
else stay as foo has them. `team-foo` is a full user kit, so the move to `team` and its presets changed nothing for
foo; moving foo onto `team` (a custom team) would turn those triggers back on, and is the user's call:

```sh
kanban kit migrate-overrides --project foo --into team-foo --dry-run   # then without --dry-run
kanban kit edit team-foo --set fallback.on.qaStalled=false --set fallback.on.conflict=false --set fallback.on.unchanged=false
kanban kit show --project foo
```

### The kit file format

What `kit create` writes, and what `kanban kit list` reads from `<home>/kits/<name>.json`. The file name must equal
`name`. A kit file may leave out any key `default` has (it resolves over `default`), though the commands always
write complete copies:

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

`kanban kit list` shows each kit, or the reason a file was refused (bad key, bad tier reference, name clash).

Per-project models and facts belong in project settings, not in a copy of the kit: `kanban kit set` (the user or
the project's orchestrator, [Project settings](#project-settings)), or at apply time
`kanban kit apply team --preset cloud --project foo --set qa.blurb="Project: Pawsome…" --set 'land.postLand=[…]'` (`--set` takes
only project settings; `--unset <key>` removes any stored key).

What a kit can't do, on purpose:

- **No code hooks.** Runoff decisions, the scoreboard and calibration are code, so they are built-in features a kit
  switches on by name. A hook API gets added only when a real kit needs one.
- **No mechanics.** Landing mode, shadow, check scripts, limits and timings are core settings
  ([CONFIG.md](CONFIG.md)).
- **No inheritance.** A kit is resolved only over `default` (`team` also with its preset), never over another user
  kit or another workspace. `kanban kit create --from` copies a kit instead, so a later change to the original (or
  its preset) doesn't reach the copy.
