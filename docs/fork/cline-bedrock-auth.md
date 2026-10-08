# Cline's Bedrock key comes from the environment

Cline cards on Bedrock (`-P bedrock -m <model>`) need an Amazon Bedrock API key and a region. Give them both in
Kanban's environment, not in Cline's `providers.json`:

- `AWS_BEARER_TOKEN_BEDROCK`: the key, a secret. In the container it comes in as a podman secret, like `GH_TOKEN`
  ([github-auth.md](github-auth.md)). Add this line to the quadlet's `[Container]` section:

  ```ini
  Secret=<secret name>,type=env,target=AWS_BEARER_TOKEN_BEDROCK
  ```

  Pipeline checks never see it, and `scripts/secret-guard.sh` blocks a push that contains its value.
- `AWS_REGION`: not a secret (`Environment=AWS_REGION=us-west-2`, or the region in `providers.json`).

`cline auth bedrock -k <key>` stores the key in plain text in `~/.cline/data/settings/providers.json`
(`providers.bedrock.settings.apiKey`). A stored key wins over the environment, so a rotated secret doesn't reach Cline
while the old key is still stored.

## What Cline does (cline 3.0.69, checked 2026-10-08)

Cline's Bedrock client (`@cline/llms`) takes `settings.apiKey` first. Without it, it takes `AWS_BEARER_TOKEN_BEDROCK`
from its own process environment. This was verified with real runs in a throwaway `CLINE_DIR`/`CLINE_DATA_DIR`:
`providers.json` held only the region and model, and the key was only in the env. It held for both paths Kanban uses:

- a direct run;
- a session in Cline's hub daemon. Every TUI card runs there, task and QA cards alike.

Without the env key, neither run got an answer.

It doesn't fall back to the env:

- when `aws.authentication` is `iam` or `profile` (a stored API key is unused then too);
- when an access-key pair (`aws.accessKey` + `aws.secretKey`) is stored without `aws.authentication: "api-key"` (the
  access keys are used).

The hub daemon keeps the environment of the card that started it. That's fine once the variable is set, since the
value is the same for every card. But a daemon started before the variable existed has no env key, and it keeps
running on the stored key until it is restarted.

## Doctor and setup

`kanban doctor` has one row for this, which replaces setup's `cline-providers` step in doctor. It reads
`providers.json` and compares env values. It never prints a key, only whether one is stored and whether it equals
the env's.

| State | Row |
|---|---|
| Env set, key stored | WARN "Cline stores a Bedrock API key in <path>; the environment already provides it (the same value / a different value …)" → `kanban cline remove-bedrock-key` |
| Env set, nothing stored | PASS |
| Env missing, key stored | WARN: the key is stored in plain text; set the env var, then remove the stored key |
| Env missing, nothing stored | WARN: Cline's Bedrock cards have no key |
| Kanban server or a Cline hub daemon without the same env value | INFO while a key is still stored (it uses that), WARN when none is |
| No region in `providers.json` or `AWS_REGION` | WARN with the `export AWS_REGION=…` line |

`kanban setup`'s `cline-providers` step only checks (status `manual`). It recommends the environment over a stored
key in the same words and prints the same command.

## `kanban cline remove-bedrock-key`

The user's command. It is in `USER_ONLY_COMMANDS`, so agent sessions are refused. It deletes only
`providers.bedrock.settings.apiKey` and leaves the region, model and every other provider alone.

- It refuses unless `AWS_BEARER_TOKEN_BEDROCK` is set in its own environment, so run it from the environment Kanban
  runs in (`podman exec`).
- It refuses while the running Kanban server or any Cline hub daemon doesn't have the same value. Restart such a
  daemon first: it serves every Cline card, so stop it while they are idle, and the next Cline card starts a new one
  from the server's environment.
- It refuses when stored access keys would take over.
- `--dry-run` shows what would change and writes nothing, not even a backup.
- Before writing, it copies `providers.json` to `<home>/backups/cline/providers.json.<UTC timestamp>` (mode 0600).
  It then replaces the file atomically, keeping its mode, and prints the rollback line
  (`cp <backup> <providers.json>`).

This follows `kanban cline apply-lemonade-models`. Kanban never writes Cline's files on its own; the user runs the
command that does.
