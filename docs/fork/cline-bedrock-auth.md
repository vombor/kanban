# Cline's Bedrock key: in the environment and stored in providers.json

Cline cards on Bedrock (`-P bedrock -m <model>`) need an Amazon Bedrock API key and a region. Kanban gets the key from
its environment, and Cline's `providers.json` must store it too:

- `AWS_BEARER_TOKEN_BEDROCK`: the key, a secret. In the container it comes in as a podman secret, like `GH_TOKEN`
  ([github-auth.md](github-auth.md)). Add this line to the quadlet's `[Container]` section:

  ```ini
  Secret=<secret name>,type=env,target=AWS_BEARER_TOKEN_BEDROCK
  ```

  Pipeline checks never see it, and `scripts/secret-guard.sh` blocks a push that contains its value.
- `AWS_REGION`: not a secret (`Environment=AWS_REGION=us-west-2`).
- `providers.bedrock.settings.apiKey` and `providers.bedrock.settings.aws.region` in
  `~/.cline/data/settings/providers.json`: run `kanban cline store-bedrock-key` once, and again after the secret
  rotates. It copies the key from the environment, so the key never goes on a command line.

## Why the key must be stored (cline 3.0.69, issue #9, checked 2026-10-08)

Every Kanban card runs Cline's interactive TUI (`--tui`). Before it runs a prompt, the TUI checks whether the provider
is configured, and that check only reads `providers.json` (and a `-k` key, which Kanban never passes):

- the provider's entry must name its provider (`settings.provider: "bedrock"`);
- it must store a key (`apiKey`, `auth.apiKey` or `auth.accessToken`) or AWS credentials (`aws.authentication` `iam`
  or `profile`, `aws.profile`, or `aws.accessKey` + `aws.secretKey`);
- it must store a region (`aws.region` or `region`).

`AWS_BEARER_TOKEN_BEDROCK` and `AWS_REGION` don't count there. When the check fails, the TUI shows "Welcome to Cline /
Connect a model provider to get started", Cline's sign-in screen. It writes no session file, never takes the prompt,
and turns typed input into a Cline account sign-in (`user.auth_started` in `cline.log`). Kanban still shows the card as
running.

This was verified in the bundled CLI and with real `cline --tui` runs in a throwaway `CLINE_DIR`/`CLINE_DATA_DIR`
(no network). With region and model stored and the key only in the env, the TUI showed the sign-in screen. With a key
stored, it ran and wrote its session. Cline's Bedrock client itself does fall back to `AWS_BEARER_TOKEN_BEDROCK` when no
key is stored. That is why an earlier version of this page, verified with headless runs only, said the environment was
enough. It recommended `kanban cline remove-bedrock-key`, and after the user ran it every Cline card on Bedrock
stopped at the sign-in screen (foo, 2026-10-08 04:31Z).

The client takes the stored key over the env's, so a rotated secret reaches Cline only when it is stored again. With
`aws.authentication` `iam`/`profile`, a stored key is unused.

## Doctor and setup

`kanban doctor` has one row for this, which replaces setup's `cline-providers` step in doctor. It reads
`providers.json` and compares it with the environment. It never prints a key, only whether one is stored and whether
it equals the env's.

| State | Row |
|---|---|
| Key and region stored | PASS |
| AWS credentials (iam/profile) and region stored | PASS (INFO when an unused key is stored too) |
| Env set, no key stored | WARN: Bedrock cards open on Cline's sign-in screen → `kanban cline store-bedrock-key` |
| Stored key differs from the env's | WARN: Cline uses the stored one → `kanban cline store-bedrock-key` |
| No region stored | WARN (also when `AWS_REGION` is set: the TUI doesn't count it) → `kanban cline store-bedrock-key` |
| Env missing, no key stored | WARN: no key; set the podman secret first (hint: this page) |

`kanban setup`'s `cline-providers` step only checks (status `manual`), says the same and prints the same command.

## `kanban cline store-bedrock-key`

The user's command. It is in `USER_ONLY_COMMANDS`, so agent sessions are refused.

- It writes `providers.bedrock.settings.apiKey` from its own `AWS_BEARER_TOKEN_BEDROCK`, so run it from the environment
  Kanban runs in (`podman exec`). Without the variable it refuses.
- When no region is stored, it stores `AWS_REGION`, else `models.bedrockRegion`.
- It changes nothing else. The model and the other providers stay as they are. When providers.json has no Bedrock entry,
  it adds one in the shape Cline writes (`settings`, `updatedAt`, `tokenSource`).
- It refuses when providers.json doesn't exist yet (start one Cline card on Bedrock first, and Cline writes the file).
  It also refuses when Bedrock is set up with AWS credentials (iam/profile or access keys); change those with
  `cline auth bedrock`.
- `--dry-run` shows what would change and writes nothing, not even a backup.
- Before writing, it copies `providers.json` to `<home>/backups/cline/providers.json.<UTC timestamp>` (mode 0600). It
  then replaces the file atomically, keeping its mode, and prints the rollback line (`cp <backup> <providers.json>`).
  If a card launch rewrote the file in the meantime, it writes nothing; run it again.

`kanban cline remove-bedrock-key` is still there, but it only refuses and points at `store-bedrock-key`.

This follows `kanban cline apply-lemonade-models`: Kanban never writes Cline's files on its own; the user runs the
command that does.

## When a card hits the sign-in screen anyway

A Cline card whose run hasn't written a session file of its own within `pipeline.recovery.stallNudgeMin` is a silent
stall of kind `no_session` (`evaluateClineSilentStall`). Its reason says "Cline is asking for sign-in" plus what
providers.json lacks, when the file shows that. Recovery escalates such a dev card right away and never nudges it,
because the sign-in screen would take the nudge as input. The watchdog reports it for QA cards too (ATTENTION.md and the
orchestrator wake). After fixing providers.json, restart the card (`kanban task resume <id>`).
