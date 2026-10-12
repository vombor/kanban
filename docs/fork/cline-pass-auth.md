# ClinePass for Cline cards: the key in the environment and stored in providers.json

ClinePass is Cline's subscription provider (provider id `cline-pass`; docs: https://docs.cline.bot/getting-started/clinepass).
Cline cards on it (`-P cline-pass -m cline-pass/<model>`, for example `cline-pass/mimo-v2.6-flash`, Cline's default)
need a ClinePass API key. Kanban gets the key from its environment, and Cline's `providers.json` must store it too.

## Where the key goes

- `CLINE_API_KEY`: the key, a secret. In the container it comes in as a podman secret, like `GH_TOKEN`
  ([github-auth.md](github-auth.md)) and the Bedrock key ([cline-bedrock-auth.md](cline-bedrock-auth.md)). Create the
  secret once:

  ```sh
  printf '%s' "$CLINE_PASS_KEY" | podman secret create cline_api_key -
  ```

  and add this line to the quadlet's `[Container]` section, then restart the container:

  ```ini
  Secret=cline_api_key,type=env,target=CLINE_API_KEY
  ```

  Without a quadlet: `podman run --secret cline_api_key,type=env,target=CLINE_API_KEY ...`. A `CLINE_API_KEY` set any
  other way in the container's environment (the environment Kanban starts from) works the same. Cline itself reads no
  `.env` file. Prefer the secret: an `Environment=CLINE_API_KEY=...` line puts the key in the unit file and in
  `podman inspect`.

  Pipeline checks never see it (`SECRET_ENV_NAMES` in `src/pipeline/checks.ts`), and `scripts/secret-guard.sh` blocks a
  push that contains its value.
- `providers["cline-pass"].settings.apiKey` in `~/.cline/data/settings/providers.json`: run
  `kanban cline store-cline-pass-key` once from that environment (`podman exec`), and again after the secret rotates.
  It copies the key from the environment, so the key never goes on a command line (`cline auth -p cline-pass -k <key>`
  would put it in argv and the shell history).

Kanban sets no base URL or model for ClinePass: Cline's own default is `https://api.cline.bot/api/v1`, and each card
names its model. `CLINE_DISABLE_CLINE_PASS_NOTICE=1`, which Kanban puts in every Cline launch, only hides Cline's
ClinePass promo notice over the TUI; it doesn't turn ClinePass off.

## Why the key must be stored (cline 3.0.70, checked 2026-10-12)

The same as Bedrock's (issue #9): every Kanban card runs Cline's interactive TUI (`--tui`), and before it runs a prompt
the TUI checks whether the provider is configured. That check only reads `providers.json`, never the environment.

This was checked in the bundled CLI and with real `cline --tui` runs in a throwaway `CLINE_DIR`/`CLINE_DATA_DIR` (and
hub), against a fake OpenAI-compatible server through a stored `baseUrl`. No real ClinePass key was used:

| providers.json | `CLINE_API_KEY` | TUI |
|---|---|---|
| no ClinePass entry | set | sign-in screen ("Welcome to Cline / Connect a model provider to get started") |
| `cline-pass` with `baseUrl` and `model`, no key | set | sign-in screen |
| `cline-pass` with `apiKey` | unset | runs, sends the stored key |
| `cline-pass` with `apiKey` | another value | runs, sends the **stored** key |
| `cline` with `apiKey`, no `cline-pass` entry | unset | runs, sends the `cline` entry's key |
| `cline` with a sign-in (`auth.accessToken`), `cline-pass` with `apiKey` | unset | runs, sends the **sign-in's** token |

ClinePass is an OAuth provider in Cline whose credentials live under the `cline` entry (`storageProviderId`). Cline
reads ClinePass's settings as the `cline` entry's `auth`, `apiKey` and `baseUrl` with the `cline-pass` entry's own
settings on top, and sends a Cline account sign-in's access token before any stored key. So:

- with only the env's key, every ClinePass card opens Cline's sign-in screen, writes no session file and never takes
  the prompt, while Kanban shows it running;
- a rotated secret reaches Cline only once it is stored again;
- with a Cline account signed in (in Cline, `providers.cline.settings.auth`), ClinePass runs on that account and
  `CLINE_API_KEY` is unused.

What couldn't be checked without a real key: that `api.cline.bot` accepts the key, Cline's default base URL itself, and
the real server's error texts (the texts below are Cline's own, from its bundle).

## Doctor

`kanban doctor` has one row for this. It reads `providers.json` and compares it with the environment. It never prints a
key, only whether one is stored and whether it equals the env's. The row appears when ClinePass is in use: a
`cline-pass` entry in providers.json, `CLINE_API_KEY` set, or `models.providers.default` = `cline-pass`.

| State | Row |
|---|---|
| The env's key stored (or a stored key and no env) | PASS |
| A Cline account sign-in stored | PASS (INFO when `CLINE_API_KEY` is set: it is unused) |
| Env set, no key stored | WARN: cline-pass cards open on Cline's sign-in screen → `kanban cline store-cline-pass-key` |
| Stored key differs from the env's | WARN: Cline uses the stored one → `kanban cline store-cline-pass-key` |
| Env missing, no key stored | WARN: no key; set the podman secret first (hint: this page) |

## `kanban cline store-cline-pass-key`

The user's command. It is in `USER_ONLY_COMMANDS`, so agent sessions are refused.

- It writes `providers["cline-pass"].settings.apiKey` from its own `CLINE_API_KEY`, so run it from the environment
  Kanban runs in. Without the variable it refuses.
- It changes nothing else: the model, the `cline` entry and the other providers stay as they are. When providers.json
  has no `cline-pass` entry, it adds one in the shape Cline writes (`settings` with `provider`, `updatedAt`,
  `tokenSource`).
- It refuses when providers.json doesn't exist yet (start any Cline card once; Cline writes the file even on its sign-in
  screen), and while a Cline account sign-in is stored, because Cline would send that before the key.
- `--dry-run` shows what would change and writes nothing, not even a backup.
- Before writing, it copies `providers.json` to `<home>/backups/cline/providers.json.<UTC timestamp>` (mode 0600). It
  then replaces the file atomically, keeping its mode, and prints the rollback line (`cp <backup> <providers.json>`).
  If a card launch rewrote the file in the meantime, it writes nothing; run it again.

Like the other `kanban cline` commands, it is the only way Kanban writes this: Kanban doesn't change Cline's files on its
own (the one exception is the Lemonade context windows in models.json, issue #31).

## Errors ClinePass returns

Cline writes ClinePass's answers about the account as error notices in the session file (`displayRole: "error"`, the
session then `failed`); it doesn't retry them itself. Kanban reads them through `getProviderAccountError()`
(`src/terminal/cline-provider-error.ts`) as provider errors, never as the model's:

| Cline's text | Recovery (dev cards) | QA cards |
|---|---|---|
| "No access to ClinePass subscription models yet. Subscribe to ClinePass, ..." | escalates to the orchestrator at once: "provider account error ..., not a model failure" (no retry, nudge or outage hold) | STALLED at once with the error, no replacement QA card; the rework stage escalates it to the orchestrator |
| "Organization accounts cannot use ClinePass subscriptions. ..." | the same | the same |
| "You have reached your ClinePass limit ... Please try again later." | the provider-error retries (`pipeline.recovery.retryBackoffMin`), then an escalation "provider usage limit ..., not a model failure" (ClinePass has no outage probe) | the usual QA agent-error replacements, then STALLED |

After fixing the account (subscribe, switch to a personal account, or wait for the limit), restart the card
(`kanban task resume <id>`).

A card that hits the sign-in screen anyway is a silent stall of kind `no_session`; its reason names what providers.json
lacks ("providers.json stores no ClinePass key"), and recovery escalates it without a nudge, as for Bedrock
([cline-bedrock-auth.md](cline-bedrock-auth.md#when-a-card-hits-the-sign-in-screen-anyway)). `kanban models vet` checks
the same rule before it creates its card and ends inconclusive (`sign_in`) right away.

## Kanban's other ClinePass rules

- **Price:** ClinePass is a flat subscription. Cline 3.0.70 itself prices every ClinePass turn at 0 (its catalog lists
  each `cline-pass/<model>` at 0, and its usage code zeroes the provider's cost) and labels the provider's cost
  "subscription". Kanban follows that: card metrics price its turns at 0 by provider (`SUBSCRIPTION_PROVIDER_IDS` in
  `src/kits/team/bench/prices.ts`, note "subscription provider: no per-token cost"), and the AWS price check proposes no
  entry for its models. The subscription fee itself isn't in the scoreboard.
- **Cloud, not local:** a QA card on ClinePass takes a cloud QA slot (`pipeline.qa.slots`), like Bedrock's.
- **Vendors:** `getModelVendor()` reads `cline-pass/<model>` by the model (`cline-pass/glm-5.3-flash` → zai,
  `cline-pass/kimi-k3` → moonshotai, `cline-pass/mimo-*` → xiaomi, `cline-pass/minimax-*` → minimax,
  `cline-pass/muse-spark-*` → meta, `cline-pass/qwen*` → qwen, `cline-pass/deepseek-*` → deepseek), so QA's
  `requireDifferentVendor` tells them apart.
- **Vetting:** no ClinePass combination is vetted or routed yet. `kanban models vet --agent cline --provider cline-pass
  --model cline-pass/<model> --role dev|qa|plan` proposes an entry once the key is stored.
