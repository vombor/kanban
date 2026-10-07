# Routing kits

A **routing kit** is the per-project policy the team workflow asks for its routing decisions. It is a JSON
document: data only, no code. The **core** (built into Kanban, the same for every project, see
[WORKFLOW.md](WORKFLOW.md)) does the mechanics: landing, snapshots, the QA gate, the rework loop, recovery and
the watchdog. Whenever a mechanic needs a routing decision, it asks the project's kit. The kit never decides how
something is done, and the core never decides who does it.

- Every project is on the built-in **`default`** kit unless its config entry names another one. `default` answers
  "no" to every question, so a project on it behaves like upstream Kanban.
- **`team`** is the built-in preset for the dev-team workflow (Cline juniors on tier-3 models, cross-vendor QA,
  same-model rework, escalation to the orchestrator).
- **User kits** live in `<home>/kits/<name>.json`.

Code: `src/kits/kit-schema.ts` (schema), `src/kits/resolve-kit.ts` (resolver), `src/kits/policy.ts` (the one
evaluator), `kits/default.json`, `kits/team.json`. Plan: `docs/fork/kit-merge-plan.md` §3.2-§3.4, §4.0.

## The questions

The core asks four questions (`RoutingPolicy` in `src/kits/policy.ts`). It always passes the card's **effective**
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
- **`requireApproval` parks the card.** It goes to Backlog as `BLOCKED: …` until the orchestrator or the user acts.
- **Only a hold stops a PASS from landing.** The hold is answered by the team kit's `runoffs` feature;
  `kanban task release-hold` is the human way out.

## Resolution

A key's value comes from the first of these that has it:

1. The workspace's `kit.overrides` in config.json (dotted key → value, e.g. `"qa.blurb"`).
2. The named kit.
3. The `default` kit.

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

`kanban kit show --project <ws>` prints every resolved value with its source (`override`, the kit's name, or
`default`). The pipeline worker reads the kit and its overrides on every evaluation, so a kit change needs no
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
| `dev.agent` | agent id | `devAssignment` | none (→ `null`) | `cline` |
| `dev.model` | `{ tier }` or `{ provider?, model }` (needs `dev.agent`) | `devAssignment` | none | `{ tier: "tier3" }` |
| `qa.enabled` | boolean | `qaPolicy`: does a dev card get QA at all | `false` | `true` |
| `qa.skip.roles` | roles | `qaPolicy`: roles that never get QA | `qa`, `triage`, `calibration`, `plan` | same |
| `qa.skip.effectiveAgents` | agent ids | `qaPolicy`: effective agents whose cards never get QA | `[]` | `[]` |
| `qa.default` | `{ agent, model?, provider? }` | `qaPolicy`: the QA agent when no route matches. No `model` = the agent's own default (Codex: `~/.codex/config.toml`) | none | `{ agent: "codex" }` |
| `qa.routes[]` | `{ devModel, agent, model?, provider?, rules?, why? }` | `qaPolicy`: `devModel` is a regex on the dev card's effective model; first match wins | `[]` | OpenAI-built → `cline` + Haiku 4.5, rules `["drive"]` |
| `qa.requireDifferentVendor` | boolean | `qaPolicy`: refuse (answer `none`) a route whose QA model has the dev model's vendor | `false` | `true` |
| `qa.rules.<name>` | text | QA prompt steps a route names in `rules`; `{outbox}` is filled in | `{}` | `drive` |
| `qa.blurb` | text | the "Project: …" line of the QA prompt | `""` | `""` (foo overrides it) |
| `qa.promptNotes.{screenshotFallback,knownBaseIssues,dbSetup}` | text | project sentences in the QA prompt | `""` | `""` (foo overrides `dbSetup`) |
| `qa.serversScript` | path or null | the script QA uses to start the project's servers in its scratch copy | `null` | `null` |
| `qa.preview` | `{ pidFile, start, stop }` or null | the preview QA screenshots go through. Started before a QA card when down, stopped after `pipeline.qa.previewIdleMin` idle minutes, only if the pid is still the one the QA gate started | `null` | `null` |
| `plan.enabled` | boolean | `planAssignment`: does the project make plan cards at all | `false` | `true` |
| `plan.agent` | agent id | the planner's agent; none = the selected agent | none | `claude` |
| `plan.model` | `{ tier }` or `{ provider?, model }` (needs `plan.agent`) | the planner's model; none = the agent's own default | none | none (the Claude CLI default) |
| `plan.startInPlanMode` | boolean | the plan card starts in the agent's plan mode | `false` | `true` |
| `plan.rules.<name>` | text | project rules added to the plan prompt, in key order | `{}` | `{}` |
| `plan.candidates[]` | `{ agent, model?, note? }` | agents and models a later runoff or calibration compares; never read for routing | `[]` | `claude` |
| `plan.note` | text | | | why there is no model pin |
| `onFail.rework` | `none` \| `same-model` | `onFail`: hand a FAIL back to the same card and model | `none` | `same-model` |
| `onFail.reworkRounds` | integer | `onFail`: FAIL rounds before `then` (capped by `pipeline.rework.maxFailRounds`) | `0` | `3` |
| `onFail.conflict` | `stop` \| `rework` | `onFail`: a merge conflict at land | `stop` | `rework` |
| `onFail.then` | `escalate` \| `stop` | `onFail`: after the rounds run out, after STALLED, after an unchanged rework | `stop` | `escalate` |
| `onFail.runoff` | `{ models: [{ agent, model, provider? }] }` or null | `onFail`: race sibling cards on these models (needs the `runoffs` feature, else escalates) | `null` | `null` |
| `escalate.to` | `"orchestrator"` \| `{ tier }` \| `{ agent, model, provider? }` | who takes an escalated card. `{ tier }` needs the `tiers` feature, else it goes to the orchestrator | `orchestrator` | `orchestrator` |
| `escalate.requireApproval` | boolean | park the escalated card in Backlog `BLOCKED:` | `false` | `true` |
| `land.postLand[]` | `{ paths, run, stopUnder? }` | commands the core runs after a land that touched a file matching `paths` (regex) | `[]` | `[]` (foo overrides it) |
| `features[]` | `scoreboard`, `bench`, `runoffs`, `calibration`, `tiers` | built-in team features that run for the project | `[]` | all five |
| `tiers.<name>[]` | `{ provider?, model, default?, note? }` | `dev.model: { tier }`, `escalate.to: { tier }`, `kanban bench tiers`, `bench runoff create --tier` | | `tier3`, `tier2`, `tier1`, `qa` |
| `dropped[]` | `{ provider?, model, at?, why? }` | models no tier lookup returns, on any provider | | five models |
| `tierRules`, `tierNotes` | text per tier | shown by `kanban bench tiers` | | |
| `prices.{region,autoSync}` | | the `bench` feature's daily AWS price check | | `us-west-2`, `true` |
| `recommends.landingMode` | landing mode | shown by `kanban kit show/apply`, **never applied** without `--landing` | | `qa` |

Checks across keys run on the resolved kit:

- a `{ tier }` reference must name a tier with at least one model that isn't dropped;
- at most one entry per tier has `default: true`;
- a route's `rules` must exist in `qa.rules`;
- `dev.model` needs `dev.agent`, `plan.model` needs `plan.agent`.

A tier lookup returns the tier's `default` entry, else its first usable one, and skips `dropped` models
(`src/kits/tier-lookup.ts`).

## How the evaluator answers

`createRoutingPolicy()` in `src/kits/policy.ts` is the only evaluator. A kit can't add code to it.

**`devAssignment`.** `dev.agent`, with `dev.model` resolved (a tier → its model). Without `dev.agent` the answer is
`null`. The provider comes from the model entry, else from `kanban models providers --for <model>`. With
`workspaces.<id>.pipeline.shadow` on, the proposal is only logged (`data/<ws>/dev-assignment.jsonl`); the card is
created as its creator set it.

**`qaPolicy`**, first match wins:

1. a role other than `dev` → `none`;
2. `qa.enabled` not `true` → `none`;
3. the role is in `qa.skip.roles`, or the effective agent is in `qa.skip.effectiveAgents` → `none`;
4. the first `qa.routes[]` entry whose `devModel` matches the effective model, else `qa.default`; neither → `none`;
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

`onFail.then: "escalate"` answers with `escalate.to` and `escalate.requireApproval`, and `"stop"` answers `stop`.
A stopped card stays in Review: one ATTENTION.md line, and the orchestrator is woken.

**`planAssignment`.** `plan.enabled` not `true` → `disabled`, and `kanban task create --role plan` is refused (the
dev agent plans its own work). Otherwise `plan.agent` (or the selected agent), `plan.model` resolved like
`dev.model` (none = the agent's own default), `plan.startInPlanMode` and the `plan.rules` texts. An agent, model
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
- **FAIL:** same-model rework for 3 rounds, then escalate to the orchestrator with `requireApproval` (tier-2 runs
  cost more than about $20 and need the user). Conflicts are reworked with rebase notes. `escalate.to: { tier:
  "tier2" }` is the one-key opt-in for automatic senior-tier escalation.
- **Features:** `scoreboard`, `bench`, `runoffs`, `calibration`, `tiers`.
- **Recommends** landing `qa`.

One known difference from the legacy kit: Claude-built dev cards get QA (by Codex). The legacy kit skipped them only
because of a literal `agentId === "claude"` check. To skip them, set `qa.skip.effectiveAgents: ["claude"]` as an
override (plan §12).

### The team features

They are built in (`src/kits/team/`) and run only for projects whose kit lists them in `features`.

| Feature | What | Data |
|---|---|---|
| `scoreboard` | one line per recorded verdict, escalation and Approve & land (events `verdictRecorded`, `escalated`, `landed`); rebuilds the Markdown table | `data/<ws>/scoreboard.jsonl`, `scoreboard.md` |
| `bench` | card metrics (turns, tokens, list-price cost), `kanban bench metrics|record-verdict|scoreboard|reset`, the daily AWS price check (a watchdog feature job) | `data/prices/` |
| `runoffs` | holds the PASS of every card in an open runoff, decides once all have passed or escalated (mean QA score, then fewer FAIL rounds, then lower cost), lands the winner and tags and discards the losers through the Done workflow; `benchOnly` lands nothing | `data/<ws>/runoffs.json` |
| `calibration` | `kanban bench calibrate <spec>`: the same QA review on fixed snapshots by several QA models | `data/<ws>/calibration/<name>/` |
| `tiers` | `escalate.to: { tier }` (a sibling card on that tier's model), `kanban bench tiers` | |

The scoreboard is the team kit's score of its routing decisions. It is not the core's record of verdicts (that is
`pipeline-state.json`), and no core decision reads it.

## Writing a user kit

1. Start from the kit closest to what you want: `kanban kit show team --json` prints it resolved.
2. Write `<home>/kits/<name>.json` with only the keys that differ from `default`. The file name must equal
   `name`, and `default` and `team` are taken.

   ```jsonc
   {
     "kit": 1,
     "name": "claude-qa",
     "description": "Claude Code builds, Codex reviews, one rework, then the orchestrator",
     "dev": { "agent": "claude" },
     "qa": { "enabled": true, "requireDifferentVendor": true, "default": { "agent": "codex" } },
     "onFail": { "rework": "same-model", "reworkRounds": 1, "conflict": "rework", "then": "escalate" },
     "escalate": { "to": "orchestrator", "requireApproval": false },
     "recommends": { "landingMode": "qa" }
   }
   ```

3. `kanban kit list` shows it, or the reason it was refused (bad key, bad tier reference, name clash).
4. `kanban kit apply claude-qa --project <ws> --dry-run` prints what would change. Without `--dry-run` it writes
   `workspaces.<ws>.kit` and keeps the workspace's existing overrides. Add `--landing qa` to switch the landing
   mode in the same step.
5. Check the result: `kanban kit show --project <ws>` (every value and its source) and `kanban doctor <path>`.

Per-project tweaks belong in overrides, not in a copy of the kit:
`kanban kit apply team --project foo --set qa.blurb="Project: Pawsome…" --set 'land.postLand=[…]'`
(the value is JSON, else text). `--unset <key>` removes one.

What a kit can't do, on purpose:

- **No code hooks.** Runoff decisions, the scoreboard and calibration are code, so they are built-in features a kit
  switches on by name. A hook API gets added only when a real kit needs one.
- **No mechanics.** Landing mode, shadow, check scripts, limits and timings are core settings
  ([CONFIG.md](CONFIG.md)).
- **No inheritance.** A kit is resolved only over `default`, never over another user kit or another workspace.
