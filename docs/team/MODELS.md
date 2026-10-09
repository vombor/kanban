# The vetted model registry

Kanban keeps the list of **agent CLI + provider + model combinations that are known to work** for each kind of work:
they make tool calls, end their turns so Kanban sees it, and don't fail on images or context. Projects route work
only to combinations on that list. A combination that would only waste a project's time erroring out is caught
before a card runs on it.

- The registry: `models/vetted.json` in the Kanban repo, bundled into `dist/cli.js` like the built-in kits, with its
  JSON Schema in `models/vetted.schema.json` (code: `src/models/vetted-registry.ts`).
- The one rule that uses it: `src/kits/routing-vetting.ts`.
- Vetting a combination: `kanban models vet` (`src/models/vetting/`).
- Showing it: `kanban models list`.

The registry changes only through the Kanban repo, never per project: `kanban models vet` writes a proposal, and the
Kanban orchestrator commits it on fork/stack. A new Kanban build then carries it to every project.

## Format

```json
{
	"agent": "cline",
	"provider": "bedrock",
	"model": "us.anthropic.claude-opus-5-5",
	"roles": {
		"plan": { "status": "vetted", "at": "2026-10-09", "cliVersion": "3.0.69",
		          "evidence": { "run": null, "summary": "foo's planner (plan cards ca9f3, 090cd, ...)" } },
		"dev":  { "status": "provisional", "at": "2026-10-06", "cliVersion": null,
		          "evidence": { "run": "runoff tier2-coupons-2026-10-06", "summary": "tier-2 runoff candidate (c9e97)" } }
	},
	"capabilities": { "toolUse": true, "images": true, "contextWindow": null, "turnEnd": true },
	"note": "optional"
}
```

| Key | Meaning |
| --- | --- |
| `agent` | the agent CLI (`cline`, `codex`, `claude`, ...) |
| `provider` | the provider the card names; `null` = none (the agent's own config, e.g. Codex's `config.toml`; for Cline, `models.providers`) |
| `model` | the model id; `null` = the agent's own default model |
| `roles.<role>` | one vetting per role: `dev`, `qa`, `plan` (a kit's `fallback` role builds, so it is vetted as `dev`). `status` `vetted`, `provisional` or `rejected` (with a `reason`), `at`, `cliVersion`, `evidence.run` (the vet run id, a runoff or calibration) and `evidence.summary` |
| `capabilities` | what runs found: native tool calls, images, context window, a turn end Kanban sees (null/missing = not checked) |
| `rejected` | `{ at, reason, scope? }`: the whole combination is refused; `scope: "model"` refuses the model on every agent and provider |

A combination can be fine for QA and not for dev: each role has its own status. The CLI version is a record, not a
gate: agent CLIs update themselves, and a newer version keeps the vetting.

Lookup (`lookupVetting`): a model rejected with `scope: "model"` is rejected everywhere; otherwise the entry with the
same agent and model counts, providers only where both sides name one (a Codex card names no provider and matches
the `codex + bedrock + sol` entry). When several entries fit, the least permissive one answers. No entry = `unknown`.

### Seeded entries (2026-10-09)

| Combination | dev | qa | plan |
| --- | --- | --- | --- |
| codex + bedrock + us.openai.gpt-6.1-sol | vetted (foo's one coder) | | |
| codex + bedrock + us.moonshotai.kimi-k3 | vetted (foo's fallback) | | |
| cline + bedrock + us.anthropic.claude-haiku-5-5 | | vetted (foo's QA) | |
| cline + bedrock + us.anthropic.claude-opus-5-5 | provisional | | vetted (foo's planner) |
| cline + bedrock + us.anthropic.claude-haiku-4-5-20251001-v1:0 | | vetted (team kit's QA route) | |
| cline + bedrock + us.openai.gpt-6.1-sol | provisional (team kit's tier-3 default) | | |
| cline + bedrock + us.moonshotai.kimi-k3 | provisional (team kit's tier-2) | | |
| cline + bedrock + us.amazon.nova-2-lite-v1:0 | provisional | provisional | |
| codex + its own default model | | provisional (team kit's `roles.qa`) | |
| claude + its own default model | | | provisional (team kit's `roles.plan`) |
| cline + lemonade + GLM-4.7-Flash-GGUF, Devstral-Small-2507-GGUF, Qwen3.6-35B-A3B-MTP-GGUF, Gemma-4-12B-it-GGUF, DeepSeek-V4-Flash-0731-GGUF-BF16 | provisional (team-local, until vetted) | | |

Rejected on every agent and provider (the kits' old `dropped` lists): `qwen.qwen3-next-80b-a3b`,
`openai.gpt-oss-120b-1:0`, `nvidia.nemotron-super-3-120b`, `us.openai.gpt-6-luna`, `us.anthropic.claude-sonnet-5-5`,
`LMX-Omni-52B-Halo`, each with its reason. A tier lookup never picks them (`getUsableTierEntries`); a user kit's own
`dropped` list still counts on top.

## Enforcement

A role may be routed only to a combination that is **vetted** for that role, or **provisional** where the user
allowed provisional combinations for the project (`workspaces.<id>.models.allowProvisional`). Rejected and unknown
combinations are refused with the reason and the `kanban models vet` command to run. One rule
(`checkRouting`), asked by every routing path:

| Path | What a refusal does |
| --- | --- |
| `kanban kit apply` (and `project add --kit`) | refused before anything is written; `--allow-provisional` sets the project's switch with it |
| `kanban kit set roles.<role>.*` (orchestrator or user) | refused when the change routes a role to a refused combination |
| devAssignment (new dev cards, CLI and create dialog; `kanban task reassign`) | the kit's proposal is `refused`: the CLI refuses the card, the dialog warns, the issue import creates it without an agent, `task reassign` leaves the card as it is (status `refused`) |
| plan cards (`answerPlanAssignment`) | the plan card is refused |
| the QA gate (`qaPolicy`) | no QA card: the dev card waits in Review with `refused: ...` in the decision log (it never lands unreviewed) |
| escalation and outage takeover | to the orchestrator (an outage keeps holding) |
| runoffs (`onFail.runoff`, `kanban bench runoff create`) | the runoff answer goes to the orchestrator; `bench runoff create` from an agent session is refused |
| `kanban bench calibrate` | refused; only the user's `--force` runs it, with a warning |
| a card's explicit agent/model (`task create`, `task update`) | from an agent session (it has a session credential): refused. From the user's shell or the browser's create dialog: allowed with a clear warning; it's the user's call |

Projects on the `default` kit route nothing (every card runs on the agent selected in Kanban settings), so nothing
is checked there. Calibration cards (Kanban's own runners: `bench calibrate`, `models vet`) are not checked by the card
rule; their runners check what they need.

`kanban doctor` lists every project's routing against the registry: a pass row per project whose routes are all
allowed, a warning per refused route with the command to run, an info row for `default`-kit projects. `kanban kit
show` prints the same per route.

## Who does what

- **The user**: allows or refuses provisional combinations for a project (`kanban models allow-provisional on|off
  --project <p>`, or `kanban kit apply ... --allow-provisional`), may pick any combination for a card in the create
  dialog or with `kanban task create --agent-id/--model` (with a warning), and decides what goes into the registry.
- **A project's orchestrator**: picks its project's role models within the registry (`kanban kit set
  roles.<role>.model ...`; `kanban models list --project <p>` shows what it may use), and runs `kanban models vet` for
  a combination it wants. It can't route outside the registry, and its explicit per-card choices must be vetted.
- **The Kanban orchestrator**: commits vet proposals to `models/vetted.json` (with `npx tsx
  scripts/write-vetted-schema.ts` after a schema change).
- **Cards**: nothing here (`models vet` is refused from a card; `models allow-provisional` from every agent session).

## Vetting

```sh
kanban models vet --agent cline --provider lemonade --model GLM-4.7-Flash-GGUF --role dev [--project <p>] [--max-min 30] [--max-cost 2]
```

It runs one fixed, throwaway smoke test in a scratch git repo in a temp dir (never a project repo, never landed):

- **dev**: read NOTES.md (a codename only it has), fix a bug so `npm test` passes without touching the tests, write
  RESULT.md with the codename and the test run's pass summary line (`ℹ pass 3`), commit, end the turn;
- **qa**: review a small diff (`clamp` returns `min` above the range) against its requirement, run the tests (they
  pass: they don't cover the bug), and write `outbox/verdict.json` in the QA format; the right verdict is FAIL with a
  blocking item and the review id in the notes;
- **plan**: write PLAN.md with the ticket id and at least three numbered steps naming the files, changing no code.

The card runs on the given project's board (default: this directory's) with role `calibration`, so the pipeline,
auto-review and the watchdog leave it alone, through the running server like `bench calibrate` (create, start,
discard). It is watched with Kanban's failure detectors, and the first one that fires ends the run: not signed in,
no turn started (`no_session`: a sign-in or trust screen takes the prompt as input), image rejection, tool calls
written as text, a tool-call loop (one finished call filling 3 of the last 4; a call still waiting for its result
never counts), Cline's silent stall, hung request, context overflow or final provider error, a failed session, no
progress for 8 min (only for agents whose session files Kanban can't read), the time cap and the cost cap. A turn
that ends (Review, settled) is checked against the task. The card is always discarded. What the environment does is
not the model's silence: a model Lemonade is still loading (`/api/v1/health` doesn't list it yet), a local model's
first reply (10 min on top, `CLINE_FIRST_REPLY_LOAD_ALLOWANCE_MS`, the same allowance recovery's silent-stall
reader gives a slow-first-call provider), a model request in flight (the hung check's, twice as long for a local
first call) and a shell tool whose command still runs. A timeout on a local provider is retried twice
(`provider_timeout`) before it counts.

It writes `<home>/data/models/vetting/<run>/report.md`, `result.json` (the run and the proposal) and `run.log`, and
prints the proposed entry: the combination's entry with this role's vetting set to `vetted` (passed), `rejected`
with the failure as the reason, or `provisional` with the reason when the harness or the environment caused the
failure (sign-in, `no_session`, a transient provider error or timeout, a hung request, a failed session), and the
capabilities seen (a harness failure records no `toolUse` from a run with no tool calls). It exits 0 only when the run passed. It never edits the
registry. One failed run may be bad luck: the orchestrator decides what to commit. The run lasts minutes, so an
orchestrator starts it in the background of its own session (it must stay in the session's process tree).
