# Container lifecycle (kanban-dev image)

The dev-pod image (`ghcr.io/vombor/kanban-dev`, built from `deploy/Containerfile` by `.github/workflows/image.yml`)
starts Kanban through `deploy/kanban-entrypoint.sh` (`/usr/local/bin/kanban-entrypoint`), which ties the dev-team
kit on the persistent volume (`/root/.kanban`) to the container's start and stop:

- **Every start** launches `/root/.kanban/bin/kit boot` in the background (wait for Kanban, then start the kit
  services). Kanban never waits for it.
- **Every stop** (`podman stop`, `systemctl stop/restart`, `podman auto-update`, host shutdown: all of them send
  SIGTERM) first runs `/root/.kanban/bin/kit prepare-restart` (tags the WIP of every running card and writes the
  restart manifest, so autoland resumes exactly those cards afterwards), for at most 45 s, then `kanban restart
  prepare` (the runtime's WIP tags and restart manifest for every workspace, with the server's start time), for
  at most 20 s. Both run while Kanban is still up. Then it passes the signal on to Kanban (which shuts down within
  10 s) and exits with Kanban's exit status.

A missing kit or `kanban`, a failing step, a step that runs past its timeout or a Kanban that is already down
never blocks or aborts the stop: the entrypoint logs one line for it and goes on. A second SIGTERM/SIGINT cuts the
running step short, skips the rest and is passed on at once.

`kanban restart prepare` gets the command's `--port`, `--host`, `--home` and `--https` as `KANBAN_RUNTIME_PORT`,
`KANBAN_RUNTIME_HOST`, `KANBAN_HOME` and `KANBAN_RUNTIME_HTTPS` (a CLI started outside the server would look on the
default port 3484). With an `Exec=` override the entrypoint can't read (`sh -c '...'`), set those in the
container's environment.

The image's command (`kanban --port 3485 ...`) runs as the entrypoint's child, so Kanban is no longer
PID 2: it sits behind `podman-init` (PID 1) and the entrypoint (PID 2), with a small pid that is about the same at
every start. An `Exec=` override still works: it replaces only the command, and the entrypoint runs whatever it gets.

## Quadlet

```ini
[Container]
Image=ghcr.io/vombor/kanban-dev:latest
AutoUpdate=registry
# podman stop's default (10 s) would SIGKILL Kanban while the pre-stop steps run: 45 s kit + 20 s restart prepare +
# 10 s Kanban + margin.
StopTimeout=90
RunInit=true
# The user's classic PAT as GH_TOKEN, from a podman secret (docs/fork/github-auth.md).
Secret=gh_pat,type=env,target=GH_TOKEN
# No Exec= needed: the image's command plus the entrypoint start the kit. Remove the old
# `Exec=/bin/sh -c '( /root/.kanban/bin/kit boot ... & ); exec kanban ...'` override from docs/RUNBOOK.md
# (harmless if left: kit boot is idempotent, but it runs twice).
# Volumes, ports, Network=, etc. unchanged.

[Service]
# systemd's own stop timeout (default 90 s) must be longer than StopTimeout, or systemd kills the unit first.
TimeoutStopSec=120
```

Apply with `systemctl --user daemon-reload` and, when no cards are running, `systemctl --user restart
<unit>.service` (no `--user` for a system unit). Without systemd: `podman run --stop-timeout 90 ...`.

The image also carries `LABEL io.containers.autoupdate=registry`. Podman copies image labels into the
container's labels, so `podman auto-update` finds the container even without `AutoUpdate=registry`; it still only
updates containers that run under a systemd unit (quadlet does that) with a fully qualified image name.

## Settings (environment)

| Variable | Default | |
|---|---|---|
| `KANBAN_START_HOOK` | `<kit>/bin/kit boot` if executable | `sh -c` command run detached at start; empty = none |
| `KANBAN_PRESTOP_HOOK` | `<kit>/bin/kit prepare-restart` if executable | `sh -c` command run on SIGTERM/SIGINT; empty = none |
| `KANBAN_PRESTOP_TIMEOUT` | `45` | seconds; the hook's process group is killed after it |
| `KANBAN_RESTART_PREPARE_HOOK` | `kanban restart prepare` if `kanban` is on PATH | `sh -c` command run after the pre-stop hook; empty = none |
| `KANBAN_RESTART_PREPARE_TIMEOUT` | `20` | seconds; as above |
| `KANBAN_KIT_HOME` | `/root/.kanban` | where `<kit>` is |
| `GH_TOKEN` | unset | the user's classic PAT (scopes `repo`, `read:packages`, `write:packages`, `workflow`). gh reads it; at start the entrypoint adds the npm `${GH_TOKEN}` reference for `@vombor` to `~/.npmrc` and runs `gh auth setup-git`. Pass it as a podman secret, not `Environment=`. Agent sessions keep it (PR cards need gh), except Copilot's; see [github-auth.md](github-auth.md) |

E.g. to tag the cards of more than one board before a stop:
`Environment="KANBAN_PRESTOP_HOOK=/root/.kanban/bin/kit prepare-restart --project foo; /root/.kanban/bin/kit prepare-restart --project kanban-2uge"`
(`kit prepare-restart` alone covers one project: the one for its cwd, else the first in kit.config.json).

## Verify

```sh
podman logs --since 10m <container> 2>&1 | grep kanban-entrypoint
```

After a start: `start hook (detached): '/root/.kanban/bin/kit boot'` and `started pid <n>: kanban ...`. After a
stop (`podman logs` still works on the stopped container): `SIGTERM: pre-stop ...`, `pre-stop hook done` (or
`timed out` / `failed`), `restart prepare done` (or `timed out` / `failed` / `skipped`), `forwarding SIGTERM`, `pid <n> exited with status ...`. The same lines plus the hooks'
output are in `/root/.kanban/logs/kanban-entrypoint.log`, which survives the container being replaced (auto-update);
`kit boot` also writes `/root/.kanban/logs/kit-boot.log`. `podman inspect <container> --format
'{{.Config.StopTimeout}}'` should print 90.
