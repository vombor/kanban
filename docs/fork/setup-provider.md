# `kanban setup-provider`: a model provider's Cline settings

Cline cards need some settings in Cline's own files (`~/.cline/data/settings/models.json` and `providers.json`) that
Kanban can't take from its environment: Cline's TUI only counts what is stored there. Kanban never writes them on its
own (the one exception is the server's Lemonade context sync, `agents.cline.lemonadeContextSync`, issue #31). They are
written by one command (user request, 2026-10-12):

```
kanban setup-provider                       # list the providers and whether each is in sync
kanban setup-provider <provider> --dry-run  # what would change; writes nothing, not even a backup
kanban setup-provider <provider> [--json]   # write it
```

| Provider | Writes | Its own options | Details |
|---|---|---|---|
| `lemonade` | models.json, the `lemonade` entry: drops its `modelsSourceUrl`, and fills in the context window, maxTokens, vision and reasoning of the models already in its `models` record as Lemonade reports them | | [MODELS.md](../team/MODELS.md), [RUNBOOK.md](../team/RUNBOOK.md) |
| `bedrock` | providers.json, the `bedrock` entry: `apiKey` from `AWS_BEARER_TOKEN_BEDROCK`, and a region (`AWS_REGION`, else `models.bedrockRegion`) when none is stored | | [cline-bedrock-auth.md](cline-bedrock-auth.md) |
| `cline-pass` | providers.json, the `cline-pass` entry: `apiKey` from `CLINE_API_KEY` | | [cline-pass-auth.md](cline-pass-auth.md) |
| `<id>` of `providers.openaiCompatible` in config.json (e.g. `triton`) | models.json, the `<id>` entry: provider name, baseUrl, protocol and the context window and maxTokens of the models it already has (never adds a model; drops a `modelsSourceUrl`); providers.json, the `<id>` entry: provider, baseUrl, model (and `apiKey` from `apiKeyEnv`) | | [openai-compatible-providers.md](openai-compatible-providers.md) |

A provider's `models` record in models.json is Cline's allow list, curated by the user by hand with
models that passed `kanban models vet` ([MODELS.md](../team/MODELS.md)). So a provider's write keeps the records it
finds and only fills in or refreshes their metadata (context window, maxTokens, vision, reasoning): it never adds or
removes a model, and it drops a `modelsSourceUrl` (Cline offers every id that URL returns). A new provider type in
the registry (e.g. an OpenAI-compatible one such as Triton) follows the same rule.

Every provider changes only its own entry, copies the file as read into `<home>/backups/cline/` (0600) before writing,
replaces the file atomically with its own mode, writes nothing when the file changed meanwhile, and never prints a key.
Keys come from the command's environment (run it where Kanban runs, `podman exec`), never from the command line. With
no provider it lists each provider's state from the same checks `kanban doctor` runs: `in sync`, `out of sync` (with
the doctor row and its command), `not in use` or `unknown` (e.g. Lemonade is down).

The registry of providers is `src/setup/cline-provider-setup.ts` (one entry per provider: what it writes, its check, its
write); the command line every doctor row, setup step and hint prints comes from `src/setup/setup-provider-command.ts`.
The old `kanban cline apply-lemonade-models`, `store-bedrock-key`, `store-cline-pass-key` and `remove-bedrock-key` are
gone, without aliases.

## Who may run it

The user, in every instance and isolation mode. Every project's orchestrator and every card is refused; there is
no privileged workspace, including the first one created. The rule is `USER_INSTANCE_COMMANDS` /
`decideUserInstanceCaller()` in `src/isolation/cli-scope.ts`. The removed `providers.setupWorkspaceId` is ignored
and doctor can remove it. An orchestrator that needs a provider tells the user.

The CLI checks this before the command runs (cli.ts's preAction), and it asks the running server
(`providers.authorizeSetup`, `src/trpc/provider-setup-api.ts`), in a session or not. The server decides with the strict
caller lookup, as `kit set` does: a session's credential counts only from its own process tree, a process without one is
traced through `/proc` to the session above it (so a card that drops its credential is still that card), and an
unidentified caller is refused. Refusals go to the calling workspace's `isolation.jsonl`. Without an answer from the server
only a process with no session credential goes ahead, and only while no Kanban server is live on the home (or the
default home): no agent session outlives its server, so that is the user. A server too old to have the route must be
restarted first.
