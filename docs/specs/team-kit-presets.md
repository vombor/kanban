# One team kit plus model presets (cloud, cline, lemonade) and custom teams

User request 2026-10-12, with two rules the user added while it was planned:
1. A project on the team kit can't redefine the team workflow. Presets and custom teams differ only in each role's agent (CLI), provider and model (plus model facts: tiers, notes).
2. One fixed behaviour for every workflow difference, with no derivation from the provider. The fallback starts automatically, without approval, for every preset and every custom team, paid or free: "if you're worried about auto fallback cost don't choose a paid model".

## Problem

The built-in team kits (`kits/team-cloud.json`, `kits/team-local.json`, `kits/team-cline.json`) are each a full copy of the team workflow plus their models. Their workflow sections have drifted apart:
- `fallback.on.outage` is on only in cloud;
- the `runoffs` feature is listed only in cloud;
- a per-vendor QA route and the `drive` QA rule exist only in cloud.

Every new model set (Triton, parked) would be another copy. A project that wants the team workflow on its own models has to copy a whole kit (foo's `team-foo`), and then its workflow drifts too.

## Goals

- One built-in `team` kit that holds the whole workflow:
  - the four role slots dev, QA, plan, fallback;
  - onFail and its rework rounds;
  - the fallback triggers and their (fixed) approval;
  - the QA rules, including requireDifferentVendor;
  - recovery and outage behaviour;
  - the features.
- Presets that hold only models: per role agent/provider/model, tier lists and notes, plan candidates, the price region, and provider-fact recommendations. The presets are `cloud`, `cline` and `lemonade` (`lemonade` is today's team-local, renamed).
- A custom team: `team` without a preset, with the project's own role models set through the existing `kanban kit set roles.<role>.agent|provider|model`.
- Today's projects keep running: stored `team-cloud`/`team-local`/`team-cline` read as team + preset, and doctor `--fix` rewrites them.
- Card 88d70's routes become the `cloud` preset.

## Non-goals

- A `triton` preset. The Triton server can't do tool calls yet. Adding it later is one JSON file plus a test (card prompt `kit-team-triton.parked.md` stays parked).
- User-defined presets in `<home>/kits/`. User kits (full kits) keep working as they are.
- Rewriting any user kit (`team-foo`) or moving foo onto `team`. That changes foo's workflow and is the user's call.
- Changing the `default` kit. It stays the single-agent, no-QA mode the Kanban project uses.

## User-visible behaviour

- **New project** (browser dialog, `kanban project create|add`):
  - The picker offers `default` (preselected), `team` with a model choice (`cloud` · `cline` · `lemonade` · `custom`), then user kits.
  - For a preset it shows the four roles' agent and model.
  - For `custom` the four rows are editable; dev and QA agents are required.
  - A note says: "The fallback starts without asking: a paid fallback model runs and costs without approval."
- **Switching a project's kit:**
  - `kanban kit apply team --preset cloud|cline|lemonade [--set roles.<role>.<field>=…] --project <path>`, or `kanban kit apply team --custom --set roles.dev.agent=… --set roles.qa.agent=… …`.
  - The same caller rule as today: the user or the project's orchestrator.
  - `kanban kit presets` lists the presets with their four roles.
- **Showing a kit:** `kanban kit show` shows `team` + the preset (or custom), each value's source (`project`, `preset:<name>`, `team`, `default`), and "fallback: starts without approval".
- **Changing a project's models:**
  - `kanban kit set roles.<role>.agent|provider|model|tier` works on a preset (overriding some roles) and on a custom team.
  - Every flow key is refused, as today.
  - A preset can't change flow keys either: the preset schema has no such keys.
- **Old kit names:**
  - `kanban kit apply team-local` (and `team-cloud`, `team-cline`, `kit create --from …`) answers "renamed: use `team --preset lemonade`".
  - Doctor warns about a stored old name, and `doctor --fix` rewrites it.

## Design

### The team kit (`kits/team.json`, new)

Workflow only, the same for everyone:
- Role slots `roles.dev|qa|plan|fallback` with notes and no models.
- QA:
  - `qa.enabled: true`, `requireDifferentVendor: true`;
  - `qa.skip.roles: [qa, triage, calibration, plan]`;
  - `qa.routes: []`, `qa.rules: {}`.
- Plan: `plan.enabled: true`, `startInPlanMode: true`.
- onFail: `rework: same-model`, `reworkRounds: 3`, `conflict: rework`, `then: escalate`, `runoff: null`.
- Fallback:
  - `fallback.on` with all five triggers on (qaFails, qaStalled, unchanged, conflict, outage);
  - `fallback.requireApproval: false`.
- Features: all five (scoreboard, bench, runoffs, calibration, tiers).
- Recommendations: `recommends.landingMode: qa`, and `recommends.settings` for recovery: `pipeline.recovery.mode: on` and `workspace.recovery.enabled: true`.

One fixed behaviour for every workflow difference between today's kits:

| Difference today | Fixed in `team` |
|---|---|
| `fallback.requireApproval` (false in all built-in kits, but per kit) | **Start at once, no approval.** Presets and projects can't set it. |
| `fallback.on.outage`: cloud on, team-local/team-cline off | **On.** After `pipeline.recovery.outage.maxMin` the fallback sibling starts. On a single-server provider (Lemonade, ClinePass) it waits on the same outage and then goes to the orchestrator: a fallback sibling is never handed on again (`refuseTakeover` in `src/pipeline/rework.ts`). The cost is one extra Backlog card per outage. |
| `runoffs` feature only in cloud | **On.** It acts only when a runoff group exists (`onFail.runoff: null`; `kanban bench runoff create` is manual). |
| `qa.routes` (cloud: Haiku 4.5 for OpenAI-built cards) | **No routes.** QA is `roles.qa` for every dev card. `qa.routes` stays in the schema for user kits. |
| `qa.rules.drive` (cloud, reached only through its route; names foo's `npm run browse`/seed script) | **Kept as text, unreached.** `team` has no route, so no card gets it; the text stays in `team.json` because routes imported from the legacy kit (`import-kit.ts`) name `drive` and must still validate. |
| recovery `recommends.settings` (team-local, team-cline only) | **In `team` for everyone.** Lemonade's turn detector `on` stays in the lemonade preset (a provider fact). |
| `prices.autoSync` (cloud true, others false) | Not workflow. The key is dropped: the price sync proposes only metered models (`listKitModels` in `src/kits/team/bench/price-sync-job.ts` filters unmetered ones), so a $0 preset has nothing to sync. |

Already the same in all three kits: onFail, rework rounds, conflict rework, the other four fallback triggers, requireDifferentVendor, the QA and plan skip lists, and plan mode.

### Presets (`kits/presets/<name>.json`, new, bundled like the kits)

- **Schema:** `kitPresetSchema` in `src/kits/kit-schema.ts`, strict: `{ preset: 1, name, description, roles, tiers, tierRules, tierNotes, dropped, plan: { candidates, note }, prices: { region }, recommends: { settings } }`.
  - The role fields are `agent|provider|model|tier|note`, as in `kitRoleModelSchema`.
  - A refine checks that a role's `tier` names one of the preset's own tiers with a default pick.
  - Any other key fails to parse, so a preset can't carry a workflow key.
- **`cloud`:** the routes of card 88d70.
  - dev: `codex` on `bedrock` / `us.openai.gpt-6.1-sol`.
  - fallback: `codex` on `bedrock` / `us.moonshotai.kimi-k3`.
  - QA: `cline` on `bedrock` / `us.anthropic.claude-haiku-5-5`.
  - plan: `cline` on `bedrock` / `us.anthropic.claude-opus-5-5`.
  - `prices.region: us-west-2`.
  - Roles name their models directly. Tiers stay only as candidate lists, if any; no other dev pick.
  - Dropped from team-cloud: the nova-2-lite tier-3 and QA candidates, the opus/kimi tier-2 lists, the per-vendor QA route.
  - Before shipping, check how a Codex card launches a Bedrock model (the Codex adapter's model/provider flags, as foo's `team-foo` does with the same ids).
  - requireDifferentVendor holds: anthropic QA vs openai dev and moonshotai fallback.
- **`lemonade`:** today's team-local models and notes:
  - dev and plan `Muse-Glimmer-30B-GGUF-Q4_K_M`, QA `gemma-4-31B-it-qat-q4_0-gguf-Q4_0`, fallback `Laguna-XS-2.1-GGUF-Q4_K_M`, all `cline` on `lemonade`;
  - the tiers and tierRules/tierNotes, including the one-GPU memory budget;
  - the plan candidates;
  - `recommends.settings` with `agents.cline.turnDetector.mode: on`.
- **`cline`:** today's team-cline models and notes:
  - dev `cline-pass/glm-5.3`, QA `cline-pass/qwen3.8-max`, plan `cline-pass/minimax-m3`, fallback `cline-pass/kimi-k3`, all `cline` on `cline-pass`;
  - the tiers (with the candidates) and notes.
- `kits/team-cloud.json`, `kits/team-local.json` and `kits/team-cline.json` are removed.

### Resolution (`src/kits/resolve-kit.ts`)

- **Layers**, first match wins: project settings (`kit.overrides`) → preset → named kit → `default`.
- `resolveKitByName(catalog, name, { preset, overrides })`. A preset is valid only with `name: "team"`; anything else is an error, and `resolveWorkspaceKit` falls back to `default` with an issue, as for a bad kit today.
- `BUILT_IN_KIT_NAMES = ["default", "team"]`; `getBuiltInPresets()` and `BUILT_IN_PRESET_NAMES = ["cloud", "cline", "lemonade"]`.
- Sources gain `preset:<name>`. `WorkspaceKitResolution` gets `presetName: string | null`.
- The merge rules are unchanged (model/tier exclusion, list entries by index, strict validation of the result).
- **`recommends.settings`** of team and preset merge as a union by `key` (preset wins on the same key). A plain array merge would replace the team's recovery settings.
- **`isReservedKitName`** keeps the old names reserved.

### Workspace config (`src/config/pipeline-config.ts`, `src/kits/renamed-kits.ts`)

- **Stored form:** `workspaces.<id>.kit = { name, preset, overrides }`, with `preset: z.string().min(1).nullable().default(null)`. `team` + `preset: null` is a custom team.
- **`renamed-kits.ts`** becomes old name → `{ name, preset }`:
  - `team-cloud` → `{ team, cloud }`
  - `team-local` → `{ team, lemonade }`
  - `team-cline` → `{ team, cline }`
  - `workspaceKitRefSchema`'s transform reads an old stored name as the pair, so every reader of `settings.kit` sees `team` + preset. Raw config.json keeps the old name until `migrateLegacyConfigKeys()` (doctor `--fix`, import-kit) rewrites it.
  - Code reading `kit.name` from the raw config entry (the kit-settings write in `src/kits/project-settings.ts`) maps through the table too.
  - `describeRenamedKit` answers with `team --preset <p>`.
- **The old `team` → `team-cloud` entry is removed:** `team` is the framework's name again. Checked 2026-10-12: no workspace's raw config holds `team` (foo `team-foo`, notes `team-local`, kanban-2uge none). Card 1 checks this again.
- **`preset`** is a non-overridable key (with `kit` and `name`).

### Project settings (`src/kits/project-settings.ts`)

- Unchanged rule: roles, model keys (`PROJECT_MODEL_KEYS`) and project facts.
- Tier keys follow the tiers the resolved kit has, so they come from the preset.
- The key classifier is exported and used by the preset schema check, so presets and project settings share one definition of "model key" vs "team key".

### Kit apply and the kit routes (`src/kits/apply-kit.ts`, tRPC `kit.applyKit`)

- Input: `preset?: string`, `custom?: boolean` (exactly one with `team`, neither for other kits), `--set` role settings as today.
- **The custom-team guard:**
  - `team` without a preset needs `roles.dev.agent` and `roles.qa.agent` (in `--set` or already stored). Without a QA agent `qaPolicy` (`src/kits/policy.ts`) answers "no roles.qa agent", and nothing would be QA'd silently.
  - Without a fallback the card goes to the orchestrator, which is allowed.
- **Misfits across a preset change:** `findMisfit` drops stored tier keys the new preset has no tier for, and says so. Role keys always fit `team`.
- The caller rule and history logging are unchanged. History logs `(kit)` and `(preset)` changes.

### Kit choices and project creation

- `src/kits/kit-choices.ts`:
  - `listKitChoices` returns `{ defaultKitName, kits, presets, errors }`; each preset has its description and its four roles from the resolved team + preset.
  - `resolveNewProjectKitName` becomes `resolveNewProjectKit(catalog, { kit, preset, custom })`.
- `src/projects/project-add.ts` (`chooseNewProjectKit`, `applyNewProjectKit`), `src/trpc/projects-api.ts` (add/create/clone inputs) and the CLI `project create|add --kit team --preset <p>|--custom`. The CLI `chooseKit` prompt asks for the preset after `team`.

### Other readers

- `src/kits/kit-report.ts` (`kit show`): the preset line, `preset:<name>` sources, "fallback: starts without approval".
- `src/kits/team/bench/price-sync-job.ts` and `src/config/import-kit.ts`: `TEAM_KIT_NAME = "team-cloud"` becomes team + preset `cloud`. `autoSync` reads `prices.autoSync !== false` as today; no built-in sets it any more.
- `src/kits/local-residency.ts`, `src/kits/kit-recommendations.ts` and doctor's kit rows read the resolved kit and need only test updates.
- `src/kits/user-kit-edit.ts`: `kit create --from team --preset <p>` writes a flattened full user kit (team + preset merged, `name` replaced).
- **Doctor:**
  - The renamed-kit row (warn + `--fix`).
  - A new row: a custom team without `roles.dev.agent` or `roles.qa.agent`.
  - The managed CLAUDE.md section text (written by `kanban setup`/doctor) names `kit apply team --preset <p>|--custom`.
- **web-ui:** `web-ui/src/components/add-project/project-kit-picker.tsx`, `web-ui/src/hooks/use-project-kit-choices.ts` and `web-ui/src/components/add-project-dialog.tsx`: the preset select, the custom rows (agent select, provider and model text), the fallback-cost note.

### Docs

- `docs/team/KITS.md`: "The team kit", "Presets" (cloud, cline, lemonade, with lemonade's one-GPU memory notes) and "Custom team" replace the team-cloud/team-local/team-cline sections; the resolution section gets the preset layer.
- `docs/team/MODELS.md`: models live in presets or project settings.
- `docs/team/CONFIG.md`: `kit.preset`.
- The AGENTS.md routing bullet:
  - built-in kits `default` and `team`, presets in `kits/presets/*.json`;
  - a preset holds only role-model, tier, note and provider-fact keys (schema-enforced);
  - one fixed team workflow;
  - the renamed table maps to `{ name, preset }`.

## Risks

- **notes changes behaviour slightly:**
  - Outage takeover is now on: a Lemonade outage past `maxMin` starts a Laguna sibling that waits on the same outage and then goes to the orchestrator.
  - Runoffs are on, with no effect without a group.
  - Its overrides are all project facts and keep applying.
- **The cloud preset puts dev on Codex with a Bedrock model.** If the Codex adapter can't launch `bedrock` / `us.openai.gpt-6.1-sol` the way foo's team-foo does, cloud dev cards fail. Card 1 verifies the launch path.
- **An old `team` meaning team-cloud:** the old rename entry is dropped because no config holds it. If one turns up, it would read as a custom team with no models: the guard row warns and QA stops. Card 1 re-checks the live config.
- **A custom team without QA** would land nothing QA'd silently. This is covered by the apply guard and the doctor row.
- **Built-in kits are bundled into `dist/cli.js`,** so the new JSON files need a rebuild before they take effect.

## Test plan

- **Unit** (`test/runtime/kits/`):
  - each preset resolves to its four roles;
  - cloud's QA vendor passes requireDifferentVendor for openai, anthropic and moonshot dev models;
  - a preset with a flow key, an unknown key, or a tier role without that tier fails to parse;
  - `team` has all five triggers on and approval false;
  - `recommends.settings` merges as a union;
  - sources show `preset:<name>`;
  - a preset on a non-team kit is refused.
- **Config:**
  - stored `team-local` and `team-cline`/`team-cloud` read as the pairs;
  - `migrateLegacyConfigKeys()` rewrites them;
  - `preset` as an override key is refused;
  - notes' real overrides (facts) resolve on team + lemonade.
- **Policy:**
  - an outage on a lemonade card past maxMin escalates to the Laguna fallback without approval;
  - that sibling's own outage goes to the orchestrator (`refuseTakeover`).
- **Apply route:**
  - `--preset`, `--custom` with and without dev/QA agents, misfits dropped across a preset change, old names answered with the rename;
  - the caller rule is unchanged (existing kit-settings tests).
- **Choices, CLI and doctor:**
  - `listKitChoices` includes the presets;
  - `project create --kit team --preset lemonade` stores the pair;
  - the doctor custom-team row.
- **web-ui:**
  - the dialog picks team + preset and custom (with required agents);
  - the note is shown;
  - `add-project-dialog.test.tsx` changes from `team-local` to team + lemonade.
- **Existing tests** that name the old kit files or names change to team + preset: KITS docs tests, kit show snapshots, import-kit, price-sync, local-residency.
- **Every card:** `npx @biomejs/biome check --write` on changed files, `npm run check` (includes web:typecheck), `npm run build`.

## Rollout / flags

- No flag. Old names parse as before and resolve to team + preset, so nothing breaks on the deploy.
- After the deploy the user runs `kanban doctor --fix /projects/notes` to rewrite notes' stored `team-local`. foo stays on its user kit `team-foo`.
- Card 88d70 is deleted: its routes are the cloud preset (card 1). Running it would edit `kits/team-cloud.json`, which card 1 removes.
- Card order: 1 (schema, resolver, presets, config) → 2 (apply, project create/add, choices, doctor) → 3 (web-ui picker).

## Open questions

None blocking. Two choices are the user's later, not needed for these cards:
- Moving foo from `team-foo` onto `team` as a custom team. This changes foo's workflow: its qaStalled, unchanged and conflict triggers would turn on, and its `drive` QA rule would go to `qa.promptNotes`.
- When to add the `triton` preset.
