# GitHub auth: one classic PAT

The user's classic personal access token (PAT) is the one credential for everything GitHub-related, except GitHub
Copilot (see below). In the container it is the environment variable `GH_TOKEN`; in GitHub Actions it is the
repository secret `GH_PAT`. The workflows' built-in `GITHUB_TOKEN` writes nothing.

## Scopes

Create a **classic** PAT (Settings → Developer settings → Personal access tokens → Tokens (classic)) with:

| Scope | Why |
|---|---|
| `repo` | gh (PRs, issues), git over https (clone, fetch, push), GitHub releases |
| `read:packages` | `npm install @vombor/kanban` (GitHub Packages wants a token even for a public package) |
| `write:packages` | `npm publish` (CI and by hand), the GHCR image push |
| `workflow` | pushing changes to `.github/workflows/*` |

## What uses it

| Who | How |
|---|---|
| gh | reads `GH_TOKEN` itself, ahead of its stored login in `/root/.config/gh` |
| git over https | `kanban-entrypoint` runs `gh auth setup-git`: gh is git's credential helper for github.com (lines in the global git config on `/root`) |
| npm install / publish of `@vombor/*` | `kanban-entrypoint` adds `@vombor:registry=https://npm.pkg.github.com` and `//npm.pkg.github.com/:_authToken=${GH_TOKEN}` to `~/.npmrc` (or `$NPM_CONFIG_USERCONFIG`). The file holds only the reference: npm expands it when it reads the file |
| Kanban's update check | reads the same `.npmrc` line (else `GH_TOKEN`); without a token it checks nothing, quietly |
| CI publish (`publish.yml`) | `NODE_AUTH_TOKEN: ${{ secrets.GH_PAT }}` for `npm publish`, and the GitHub release |
| GHCR push (`image.yml`) | `docker/login-action` with `secrets.GH_PAT` |
| Agent sessions (Claude, Codex, Cline, Copilot, ...) | keep `GH_TOKEN`: PR-mode cards need gh, and `/root/.config/gh` is readable by them anyway (Copilot itself runs on `COPILOT_GITHUB_TOKEN`, see below) |
| Pipeline checks (`src/pipeline/checks.ts`) | never see it: `GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_GITHUB_TOKEN` and `AWS_BEARER_TOKEN_BEDROCK` are removed, so a project's tests can't read them |
| `scripts/secret-guard.sh` | counts the values of `GH_TOKEN` / `GITHUB_TOKEN` / `COPILOT_GITHUB_TOKEN` / `AWS_BEARER_TOKEN_BEDROCK` as known secrets and blocks a push that adds one |

`GITHUB_TOKEN` is accepted as a fallback for `GH_TOKEN` in the container, but set `GH_TOKEN`.

The Bedrock key `AWS_BEARER_TOKEN_BEDROCK` (with `AWS_REGION`) comes in through the same podman-secret route
(`Secret=<name>,type=env,target=AWS_BEARER_TOKEN_BEDROCK`) and is handled like `GH_TOKEN`: pipeline checks never see
it and secret-guard knows its value. Agent sessions keep it, since Cline cards on Bedrock read it from the env (Cline's
shared hub daemon keeps the env of the card that started it, which is fine: the value is the same for every card).
`AWS_REGION` is not a secret and stays everywhere.

The entrypoint changes nothing when neither variable is set (gh then uses its login in `/root/.config/gh`). It never
prints the token, also not under `set -x`, and never writes it to a file. Its `.npmrc` edit is idempotent and keeps
the user's other lines; an auth line for `npm.pkg.github.com` with some other value is the user's and is left alone.

### Copilot is the exception

The Copilot CLI takes `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN` ahead of its own login
(`copilot help environment`, verified on 1.0.93). The PAT is not a Copilot credential, so the container also carries
Copilot's own token in `COPILOT_GITHUB_TOKEN` (a second podman secret, below). Kanban passes the env to Copilot
launches as is (task, QA, calibration and orchestrator sessions; `copilotAdapter` in
`src/terminal/agent-session-adapters.ts`), so Copilot runs on `COPILOT_GITHUB_TOKEN` while gh, git and npm inside the
card keep the PAT. Until 2026-10-08 Kanban removed all three variables from Copilot launches so Copilot used its
`copilot login`; that would now take Copilot's own token away.

`COPILOT_GITHUB_TOKEN` is a secret like the PAT: pipeline checks never see it and secret-guard knows its value.
`kanban doctor` names the credential Copilot cards run on (never its value), warns when there is neither
`COPILOT_GITHUB_TOKEN` nor a Copilot login, and warns when the PAT would win over the login because
`COPILOT_GITHUB_TOKEN` is missing.

## Setting it up

### Container (podman secret)

```sh
printf '%s' "$PAT" | podman secret create gh_pat -
printf '%s' "$COPILOT_TOKEN" | podman secret create copilot_github_token -
```

Quadlet (preferred over a plain `Environment=GH_TOKEN=...`, which puts the token in the unit file and in
`podman inspect`):

```ini
[Container]
Secret=gh_pat,type=env,target=GH_TOKEN
Secret=copilot_github_token,type=env,target=COPILOT_GITHUB_TOKEN
```

Without a quadlet: `podman run --secret gh_pat,type=env,target=GH_TOKEN
--secret copilot_github_token,type=env,target=COPILOT_GITHUB_TOKEN ...`. Restart the container so the entrypoint
sets up npm and git and Copilot cards get their token. Without the Copilot line, Copilot takes the PAT over its
`copilot login` (doctor warns).

### Repository secret

```sh
gh secret set GH_PAT --repo vombor/kanban   # pastes the PAT from stdin
```

`publish.yml` and `image.yml` fail at their first step with a clear message when `GH_PAT` is missing.

### Switching a checkout from SSH to HTTPS

The entrypoint never changes remote URLs. To have a repo use the PAT instead of an SSH key:

```sh
git -C /projects/<repo> remote set-url origin https://github.com/<owner>/<repo>.git
git -C /projects/<repo> fetch origin   # authenticates through gh's credential helper
```

### Outside the container

```ini
# ~/.npmrc
@vombor:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GH_TOKEN}
```

with `GH_TOKEN` exported in the shell (any PAT with `read:packages` is enough to install).

## Rotating the PAT

1. Create the new classic PAT with the same scopes.
2. Container: `podman secret rm gh_pat`, then `printf '%s' "$NEW_PAT" | podman secret create gh_pat -`, then restart
   the container (when no cards are running). `.npmrc` and the git helper need no change: they only reference
   the variable.
3. CI: `gh secret set GH_PAT --repo vombor/kanban` with the new PAT.
4. Revoke the old PAT on GitHub.
5. Check: `gh auth status`, `npm view @vombor/kanban version`, `kanban doctor`.
