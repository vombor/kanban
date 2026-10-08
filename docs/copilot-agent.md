# GitHub Copilot agent

Kanban can run [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) (`copilot`, npm `@github/copilot`) as a task agent (agent id `copilot`). Based on upstream PR #286, ported to per-task agent settings.

- **Auth:** the agent uses your Copilot subscription. Set `COPILOT_GITHUB_TOKEN` in Kanban's environment (it wins over `GH_TOKEN`/`GITHUB_TOKEN` and the login; see `docs/fork/github-auth.md`), or run `copilot login` once.
- **Model per card:** `--model <id>`, e.g. `claude-sonnet-5`, `claude-opus-5.5`, `gpt-6.1-sol`, `gpt-6-luna`, `kimi-k3`, or `auto`. `copilot help config` lists the ids your Copilot CLI version knows. Cost is charged as Copilot AI credits (or premium requests on legacy plans); see `copilot help billing`.
- **Reasoning effort per card:** `--effort` maps to `--reasoning-effort` (none, minimal, low, medium, high, xhigh, max).
- **Provider:** `github` (or unset) means the subscription. Any other provider id names a bring-your-own-key profile in `<Kanban home>/copilot-providers.json` (`~/.kanban` unless `KANBAN_HOME` says otherwise) (mapped to Copilot's `COPILOT_PROVIDER_*` env vars; profiles reference keys by env var name or command, never inline).
- **Modes:** autonomous adds `--allow-all-tools --allow-all-paths` (not `--autopilot`, so Copilot still stops for questions). Plan mode starts with `--plan` and never gets the allow flags. Without either, Copilot asks for permissions in the card terminal.
- **Card state:** Kanban writes `.github/hooks/kanban.json` in the worktree (git-excluded; removed when the session ends): `agentStop` → Review, `userPromptSubmitted` → In Progress, other events → activity. An output detector moves an idle card to Review 3 s after Copilot's "Esc to cancel" status bar disappears.
- **Resume:** restoring a card from Done resumes its Copilot session (`--resume=<id>`, found by worktree path in `~/.copilot/session-state/*/workspace.yaml`).
- **Worktree trust:** the worktree is added to Copilot's trusted folders (`~/.copilot/config.json`) so no trust dialog blocks the launch.
- **Typing into the terminal:** Copilot ignores input while unfocused, so Kanban sends a focus-in escape before pasting a prompt.
