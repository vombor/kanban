# Shared provider pacing

Provider concurrency is **opt-in**, independent of subscription quota and local model residency. Without a cap,
Kanban keeps its existing dispatch behavior. A cap limits simultaneous model turns across dev, QA, fallback,
explicit starts/resumes, dependency starts, recovery and rework within one Kanban instance. Existing turns are not
interrupted when the cap is lowered. Idle TUIs do not permanently occupy slots; a recently ended turn keeps its
normal settle window before the slot is freed.

## User and project settings

Global Settings → Agents → Agent coordination has a maximum-active-turns select per discovered or saved provider.
Choose Unlimited to remove a user cap; save with the popup's **main Save**. Saved custom provider ids/limits are kept.

The user can also use:

```sh
kanban config set providerConcurrency.cline-pass 1
kanban config unset providerConcurrency.cline-pass
```

These write only `config.json`'s `providerConcurrency` map. A project's own orchestrator or the user may contribute
restrictive pacing through the strict scoped server route:

```sh
kanban pipeline provider-limit cline-pass 1 --workspace <project-id>
kanban pipeline provider-limit cline-pass --unset --workspace <project-id>
kanban pipeline provider-status --workspace <project-id> --json
```

The effective shared cap is the **minimum** of the user cap and registered projects' contributions. No orchestrator
can raise another project's cap, mutate global caps, or change the provider/model/kit workflow through pacing. Removing
a project's own contribution doesn't override any remaining cap. A saved invalid critical pacing configuration fails
closed rather than silently allowing unlimited launches. Limits are positive integers 1–1024.

Provider-selecting CLIs use the provider id (`cline-pass`, `bedrock`, configured OpenAI-compatible ids, …); opaque
CLIs use `agent:<id>`. If a provider-selecting CLI's effective provider cannot be determined, admission conservatively
reserves configured provider pools instead of evading them. Kanban does not schedule standalone CLI processes or
arbitrary manual typing into TUIs; these controls cover supported Kanban-generated starts/input, not tool/provider
network traffic outside Kanban.

## Queue and quota behavior

A requested start waits instead of being rejected/deleted. Its private durable intent lives in
`<home>/data/<project>/provider-starts.json` (0600); no credentials or caller authorization tokens are saved there.
Cards show the queued provider/deadline and the CLI returns `queued: true`. Status shows the effective cap, own-project
queue and holders, plus only an aggregate count for other projects—never their card ids, prompts or secrets.

The broker serializes concurrent admission and reserves slots before launch, while calling the ordinary guarded
session-start path. Duplicate requests do not launch twice. Queues survive restarts and quota holds hydrate before
admission; due subscription retries are serialized, not all fired at reset. Quota holds remain separate: concurrency
does not increase the allowance. Cloud QA still also obeys the machine-wide QA slot pool.

Before a queued launch, Kanban rechecks the live card's requirements, model/agent, current review disposition and
native reviewer state. A changed, Done/deleted or superseded card doesn't launch an old prompt. Stop cancels that
card's intent; supported cleanup and queue reconciliation remove its badge. A corrupt queue is kept and reported,
never overwritten as empty. Shutdown leaves interrupted pending intents available for the next server to reconcile.

Supported recovery/rework inputs to a settled live TUI use the same provider pool. A human's `task send` is refused
with a clear capacity/quota reason when it cannot safely submit; automatic input waits behind the existing typed-input
hold, which still protects user drafts. No board dependency between racers is required, so held runoff PASSes cannot
deadlock provider pacing.
