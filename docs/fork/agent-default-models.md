# Default model per agent

Settings → **Agents** sets, for each agent CLI, the model (and where the CLI takes them,
the reasoning effort and provider) that Kanban passes at launch when a card names no model. It is how the
orchestrator sidebar runs on a chosen Codex model without editing `~/.codex/config.toml`, which sets one model for
every Codex session.

## Where it is stored

`agentDefaults` in Kanban's `config.json`, per agent id, in the card settings' shape:

```json
{ "agentDefaults": { "codex": { "modelId": "sol", "reasoningEffort": "high" }, "cline": { "providerId": "lemonade", "modelId": "Qwen3-Coder-Next-GGUF" } } }
```

It changes only through the settings save (`runtime.saveConfig`, which replaces the whole map). Kanban never writes an
agent's own config (`~/.codex`, `~/.claude`, `~/.cline`). Values are passed verbatim and never checked: Kanban keeps
no routing model allow list. Agent selection, permission mode and configuration share one box; only the selected
agent's defaults are visible. All fields are selects, with a CLI-default choice and preserved options for saved
values outside the current catalog. Switching agents does not erase either agent's edits or stored defaults.

Choices are discovered lazily through `runtime.getAgentSettingsOptions`: Claude's SDK initialization metadata
(no prompt or persisted session), Codex's native `model/list`, Copilot's SDK catalog (no session), Cline's configured
models.json records and advertised thinking levels, and Droid's advertised models/effort levels. The metadata is
cached briefly; it is picker data, not launch/routing validation. A failed lookup keeps the saved default and
shows a scoped diagnostic. No provider credential is returned to the browser.

A field the agent can't take at launch
(capability `none` in `kanban agents`, e.g. Kiro's model) is disabled, and a stored value for it is dropped.

## Precedence at launch

1. The card's own model (`agentSettings.modelId`). A routing kit's role model is on the card too: the kit writes it
   onto the card when it assigns it (`devAssignment`, the QA gate, plan cards), so it counts as the card's.
2. Kanban's default for the launched agent.
3. Nothing: the CLI's own config.

The default is one unit: a card that names a model keeps its own provider and effort (the default's effort was
chosen for the default's model); a card without a model gets the default's model, and its provider and effort unless
the card sets those itself. The rule is `resolveLaunchAgentSettings()` (`src/core/task-agent-settings.ts`), applied in
`runtimeApi.startTaskSession`, the one launch path of task cards, QA cards and the orchestrator's sidebar session,
and in `kanban orchestrator run` (the watchdog's headless wakes: `claude -p … --model --effort`, `codex exec -m …
-c model_reasoning_effort=…`). The session summary's `modelId` is the model the launch passed.

## Each agent's mechanism

Checked against the installed CLIs' `--help`; Droid now exposes its choices and model details through
`droid exec --help` in the installed container:

| Agent | Model | Effort | Provider |
| --- | --- | --- | --- |
| Claude Code | `--model` | `--effort` (low … max) | — |
| Codex | `-m` / `--model` | `-c model_reasoning_effort=<e>` | — (its `config.toml`) |
| Cline | `-m` / `--model` | `--thinking` (none … xhigh) | `-P` / `--provider` |
| Copilot | `--model` | `--reasoning-effort` | Kanban's BYOK profile |
| Droid | `--model` | `--reasoning-effort` | — |
| Kiro | none | none | none |

## Where it shows

- The board card's agent pill: a card with no model of its own and no session yet shows the default's model, with
  "Default model for this agent (Kanban settings)" in its tooltip; after a run it shows the model the sessions used.
- The create dialog's model and effort fields show it as their placeholder (`Default: <model>`).
- `kanban doctor` prints one INFO row listing the defaults that are set.
- The pipeline's effective model of a card without one (`agentDefaultModels`) takes the default before the CLI's own
  (Cline's `lastUsedProvider` model).
