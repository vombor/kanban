# Models: Cline's models.json is the allow list

Kanban keeps **no list of allowed models** (the vetted model registry, `models/vetted.json`, was removed on
2026-10-12, user decision). Any project may put any model on any role: the kit gives defaults, the project overrides
them (`kanban kit set roles.<role>.agent|provider|model|tier ...`), a card may name its own (`kanban task create
--agent-id/--model`, the create dialog), and Kanban neither refuses nor warns about the choice. Vendors are still
read from whatever model is chosen (`getModelVendor()`), so a kit's `qa.requireDifferentVendor` still holds.

- **Cline cards**: Cline's own `models.json` (`<cline data>/settings/models.json`) is the allow list. A provider
  with an entry there offers only the models in its `models` record, and the provider must have **no**
  `modelsSourceUrl` (Cline offers every id that URL returns, so a dynamic list would offer unvetted models). The
  Kanban orchestrator curates the record by hand, with models that passed `kanban models vet`.
- **Other agents** (Claude Code, Codex, Copilot, ...): no model check at all.

## Who does what

- **The Kanban orchestrator** vets a model with `kanban models vet` (below) and, once it passed, adds it to the
  provider's `models` record in Cline's models.json by hand (a dry `kanban setup-provider <provider> --dry-run`
  then shows the metadata it fills in). It takes a model out the same way.
- **`kanban setup-provider <provider>`** (the user or the Kanban orchestrator, [setup-provider.md](../fork/setup-provider.md))
  never adds or removes a model: it keeps the records it finds, only fills in or refreshes their metadata (context
  window, maxTokens, vision, reasoning) and drops a `modelsSourceUrl`. Every provider type in its registry follows
  that rule. The server's Lemonade context sync writes only the context windows of models already in the record.
- **A project's orchestrator** picks its project's role models (`kanban kit set roles.<role>.model ...`). For a Cline
  role, `kanban doctor` warns when the provider's record doesn't list the model (Cline couldn't select it).
- **Cards**: nothing here (`models vet` is refused from a card).

## Doctor

- `cline-models-source` (setup step) and doctor: a Lemonade `modelsSourceUrl` is reported, with
  `kanban setup-provider lemonade` to drop it.
- The Lemonade models row: metadata that differs from what Lemonade reports (with the command), and record models
  Lemonade doesn't list (kept; pull the model or take it out of the record).
- The allow-list row (`src/doctor/cline-models-allow-list-checks.ts`): a kit role (roles, QA routes, the fallback,
  runoff models) or an open card that puts a Cline card on a model its provider's models.json record doesn't list is
  a warning, nothing more. A provider without an entry in models.json (Cline's built-in ones, e.g. `bedrock`,
  `cline-pass`) has no record to check.
- An old `workspaces.<id>.models.allowProvisional` in config.json still parses and is ignored; doctor warns and
  `--fix` deletes it (`migrateLegacyConfigKeys()`).

## Vetting

```sh
kanban models vet --agent cline --provider lemonade --model Qwen3.8-27B-GGUF-UD-Q4_K_XL --role dev [--project <p>] [--max-min 30] [--max-cost 2] [--capacity-wait-min 30]
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
discard). Before it creates the card it waits for the provider's capacity (`models.providerCapacity`), counted over
every project's In Progress cards as the QA gate counts them (the server's `models.capacity` route; other projects'
cards are only counted): a third Lemonade model would evict another project's, whose next request then evicts the vet
model (issue #25, 2026-10-10: five of 17 runs got only "No model loaded"). After `--capacity-wait-min` it gives up
with the holders as the reason, and no card. It is watched with Kanban's failure detectors, and the first one that fires ends the run: not signed in,
no turn started (`no_session`: a sign-in or trust screen takes the prompt as input), image rejection, tool calls
written as text, a tool-call loop (one finished call filling 3 of the last 4; a call still waiting for its result
never counts), Cline's silent stall, hung request, context overflow or final provider error, a failed session, no
progress for 8 min (only for agents whose session files Kanban can't read), the time cap and the cost cap. A turn
that ends (Review, settled) is checked against the task. The card is always discarded. What the environment does is
not the model's silence: a model a local provider is still loading (Lemonade's `/api/v1/health`
doesn't list it yet), a local model's
first reply (10 min on top, `CLINE_FIRST_REPLY_LOAD_ALLOWANCE_MS`, the same allowance recovery's silent-stall
reader gives a slow-first-call provider), a model request in flight (the hung check's, twice as long for a local
first call) and a shell tool whose command still runs. A timeout on a local provider is retried twice
(`provider_timeout`) before it counts. A turn that ends on a provider or transport error is the environment's, not
the model's: a context overflow (llama.cpp's "Context size has been exceeded." included) and any error notice Cline
writes in place of a reply (its session message has `metadata.displayRole: "error"`: "No model loaded: <model>",
"Response stream ended without a finish reason."); a rejected request over a malformed tool call stays the model's.

It writes `<home>/data/models/vetting/<run>/report.md`, `result.json` (the run, the agent CLI's version and the
summary) and `run.log`, and prints the outcome and its summary: **passed**, **failed** (with the failure) or
**inconclusive**, with the time, the cost and the tool-call counts (native and written as text). A run the harness
or the environment cut short is inconclusive (sign-in, `no_session`, no capacity, a provider or transport error or
timeout, a context overflow, a hung request, a failed session): it says nothing about the model. It exits 0 when the
run passed, 1 when it failed and 2 when it was inconclusive. It changes nothing else: no registry, no models.json.
One failed run may be bad luck: the orchestrator decides what goes into models.json. The run lasts minutes, so an
orchestrator starts it in the background of its own session (it must stay in the session's process tree).

## ClinePass (`cline-pass`)

ClinePass is Cline's subscription provider (ids `cline-pass/<model>`, e.g. `cline-pass/mimo-v2.6-flash`,
`cline-pass/glm-5.3-flash`, `cline-pass/kimi-k3`). Its key comes from Kanban's environment (`CLINE_API_KEY`, a podman
secret) and must be stored in Cline's providers.json with `kanban setup-provider cline-pass` (the user or the Kanban
orchestrator runs it), because Cline's TUI doesn't count the env's key (verified with real TUI runs, 2026-10-12): [cline-pass-auth.md](../fork/cline-pass-auth.md).
For Kanban it is a cloud provider: a QA card on it takes a cloud QA slot. Its turns price at 0 by provider
(`SUBSCRIPTION_PROVIDER_IDS`, as Cline itself prices them), `getModelVendor()` reads the model after the
`cline-pass/` prefix, and its account answers ("No access to ClinePass subscription models yet", "Organization
accounts cannot use ClinePass subscriptions") escalate to the orchestrator at once as provider errors, while its usage
limit gets the provider retries first. It has no outage probe.
`kanban models vet --agent cline --provider cline-pass --model cline-pass/<model> --role <role>` vets a model, and
ends inconclusive (`sign_in`) at once while no key is stored.

Passed `kanban models vet` on cline 3.0.70 (2026-10-12; $0 per run on the subscription), all `cline + cline-pass`,
for dev and qa (none was run for plan):

| Model | dev | qa | plan |
| --- | --- | --- | --- |
| cline-pass/mimo-v2.6-flash | passed | passed | |
| cline-pass/mimo-v2.6-pro | passed | passed | |
| cline-pass/deepseek-v4.1-flash | passed | passed | |
| cline-pass/glm-5.3 | passed | passed | |
| cline-pass/qwen3.8-max | passed | passed | |
| cline-pass/muse-spark-1.3-contributor | passed | passed | |
| cline-pass/kimi-k3 | passed (ClinePass: "will consume usage faster than others") | passed | |
| cline-pass/minimax-m3 | passed | passed | |

The same day `cline + lemonade + Laguna-XS-2.1-GGUF-Q4_K_M` passed for dev and qa (not plan).

## OpenAI-compatible servers (`providers.openaiCompatible`)

A server that speaks the OpenAI chat API is a provider by config alone: `providers.openaiCompatible.<id>` in
config.json, then `kanban setup-provider <id>` ([openai-compatible-providers.md](../fork/openai-compatible-providers.md)).
With `local: true` it is a local provider like Lemonade below (price 0, no cloud QA slot, the load allowance). Its
outage probe is its model list, and its `loaded` flag (where the server sends one) tells the vet probe a model is still
loading. The user's Triton/TensorRT-LLM router (`triton`, `http://triton.tailedf020.ts.net/v1`) is the first one. It
reports no context windows (Kanban writes 32768 unless config.json says otherwise) and no limit on loaded models
(no `models.providerCapacity.triton`), and on 2026-10-12 its `qwen3.6-35b-a3b` sent tool calls as text, not
`tool_calls`, so Cline couldn't use its tools: fix that on the server before vetting. No Triton model is in Cline's models.json yet.
Once its tool calls work: `kanban models vet --agent cline --provider triton --model <id> --role dev` (and
`--role qa`).

## Local provider: Lemonade

A provider that runs models on the user's own hardware costs nothing per token (`LOCAL_PROVIDER_IDS` in
`src/kits/team/bench/prices.ts`, read through `isLocalProvider()`, plus every `local: true` OpenAI-compatible
provider of config.json). Built in, that is **Lemonade** (`lemonade`, llama.cpp
on this machine, `http://localhost:13305/api/v1`): its turns are priced at 0, a QA card on it takes no cloud QA slot
(`pipeline.qa.slots`) and waits only for `models.providerCapacity.lemonade`, a vet run gives the first reply the local
load allowance, and an unreachable server is a provider outage (backoff retries, then the outage hold).

- Cline's model list: the lemonade entry's `models` record in models.json, curated by the Kanban orchestrator; no
  `modelsSourceUrl`. `kanban setup-provider lemonade` (the user or the Kanban orchestrator) fills in the record's
  metadata from Lemonade and drops a `modelsSourceUrl`. Kanban's `/api/model-lists/lemonade` route still answers
  (downloaded models with `models.lists.lemonade.requireLabels`, limited to `models.lists.lemonade.include` when
  the user set one), but Cline is no longer pointed at it. A `provider.defaultModelId` the record doesn't list is
  moved to the record's first model by `kanban setup-provider lemonade`.
- Models loaded at once: `/api/v1/health` `max_models.llm` (doctor and `kit show` compare it with Kanban's capacity).
- Outage probe and "is the model loaded?" (vet): `/api/v1/health`.
- Context windows: `recipe_options.ctx_size`, kept in sync by the server.

Cline 3.0.70's TUI opens its sign-in screen for a custom provider without an API key unless providers.json stores its
`provider`, `baseUrl` **and** `model` (models.json's `baseUrl` doesn't count); `describeClineTuiSignInGap()` checks that rule for Lemonade.

