# Container lifecycle (ghcr.io/vombor/kanban image)

The pod runs project work only; Kanban itself is developed outside it, and how a push becomes the pod's next image
is in [development.md](development.md).

The dev-pod image (`ghcr.io/vombor/kanban`, built from `deploy/Containerfile` by `.github/workflows/image.yml`)
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
- **Kanban's own update restart** (`kanban restart update`, below): Kanban runs `kanban restart prepare` itself, shuts
  down and exits with status 75. The entrypoint runs no pre-stop step for an exit it didn't signal, logs
  `exit 75: Kanban asked for an update restart` and exits with 75, so the container exits and systemd starts it again.

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
Image=ghcr.io/vombor/kanban:latest
AutoUpdate=registry
# Every container start pulls :latest first when the registry's digest differs from the local image (podman run
# --pull=newer; a failed pull falls back to the local image). Together with Restart=always this makes "the container
# exited" = "update and come back" (kanban restart update, below). Quadlet's Pull= key: podman 4.6.0 and later.
Pull=newer
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
# Start the container again whenever it exits (Kanban's update restart exits 75, a crash anything else). Quadlet sets
# no Restart= for a .container unit. A manual `systemctl --user stop <unit>` still stops it: systemd never restarts a
# unit that was stopped on purpose.
Restart=always
RestartSec=5
```

Apply with `systemctl --user daemon-reload` and, when no cards are running, `systemctl --user restart
<unit>.service` (no `--user` for a system unit). Without systemd: `podman run --stop-timeout 90 ...`.

Until 2026-10-12 the image was `ghcr.io/vombor/kanban-dev`, which CI no longer pushes, so `podman auto-update`
stops finding new builds there. A pod still on it: set `Image=ghcr.io/vombor/kanban:latest`, `systemctl --user
daemon-reload`, then restart the unit; the old `kanban-dev` package on GHCR can be deleted afterwards.

The image also carries `LABEL io.containers.autoupdate=registry`. Podman copies image labels into the
container's labels, so `podman auto-update` finds the container even without `AutoUpdate=registry`; it still only
updates containers that run under a systemd unit (quadlet does that) with a fully qualified image name.

## Updating from inside (`kanban restart update`)

Kanban can't pull an image from inside its container, but with the unit's `Pull=newer` and `Restart=always` it
doesn't have to: it only has to exit. `kanban restart update` is the user's (since 2026-10-13 Kanban is developed outside
the pod, [development.md](development.md), so the Kanban project's orchestrator that had the user's standing
permission of 2026-10-12 no longer runs in the pod; every orchestrator and every card is refused, the server's
`restart.update` route decides with the strict caller):

1. refuses outside a container (no `/run/.containerenv`);
2. compares the running build (`KANBAN_IMAGE_REVISION`/`KANBAN_IMAGE_CREATED`, set from build args by CI; the same
   values as the `org.opencontainers.image.revision`/`.created` labels) with the labels of
   `ghcr.io/vombor/kanban:latest`, read anonymously from GHCR, and refuses when it isn't newer, the running image has
   no stamp (a local build) or the registry can't be read;
3. refuses while any card is In Progress in any project (their agents stop with the container; after the restart
   restart recovery resumes them where `pipeline.recovery.mode` is `on`);
4. runs the same restart prepare as the entrypoint's stop step for every workspace (WIP tags + restart manifest),
   with the update recorded in the manifest, answers, and shuts Kanban down gracefully with exit status 75.

`--force` skips 2 and 3 (an unreachable registry, the same image, running cards), `--dry-run` checks and prints
what would happen without tagging, writing or stopping anything. Every request, refused or not, is logged to the
server log and `/root/.kanban/logs/restart-update.jsonl` (who, the running build, `:latest`'s build and digest).
After the restart the watchdog's "Kanban restarted" wake says `updated from <old build> to <new build>`, or that the
container came back on the old build (no `Pull=newer` in the unit, or the pull failed).

Kanban can't check the unit from inside: the Quadlet file is on the host, and a rootless container's
`/run/.containerenv` names neither the unit nor the image. So doctor doesn't warn about a unit without `Pull=newer`
or `Restart=always`. Without `Restart=always` the update restart only stops the container (start it with
`systemctl --user start <unit>`); without `Pull=newer` it comes back on the old image, which the wake then says.

## Settings (environment)

| Variable | Default | |
|---|---|---|
| `KANBAN_START_HOOK` | `<kit>/bin/kit boot` if executable | `sh -c` command run detached at start; empty = none |
| `KANBAN_PRESTOP_HOOK` | `<kit>/bin/kit prepare-restart` if executable | `sh -c` command run on SIGTERM/SIGINT; empty = none |
| `KANBAN_PRESTOP_TIMEOUT` | `45` | seconds; the hook's process group is killed after it |
| `KANBAN_RESTART_PREPARE_HOOK` | `kanban restart prepare` if `kanban` is on PATH | `sh -c` command run after the pre-stop hook; empty = none |
| `KANBAN_RESTART_PREPARE_TIMEOUT` | `20` | seconds; as above |
| `KANBAN_KIT_HOME` | `/root/.kanban` | where `<kit>` is |
| `KANBAN_IMAGE_REVISION`, `KANBAN_IMAGE_CREATED` | set by the image | the image's build (commit, build time), for `kanban restart update`; don't override them |
| `GH_TOKEN` | unset | the user's classic PAT (scopes `repo`, `read:packages`, `write:packages`, `workflow`). gh reads it; at start the entrypoint adds the npm `${GH_TOKEN}` reference for `@vombor` to `~/.npmrc` and runs `gh auth setup-git`. Pass it as a podman secret, not `Environment=`. Agent sessions keep it (PR cards need gh), except Copilot's; see [github-auth.md](github-auth.md) |

E.g. to tag the cards of more than one board before a stop:
`Environment="KANBAN_PRESTOP_HOOK=/root/.kanban/bin/kit prepare-restart --project foo; /root/.kanban/bin/kit prepare-restart --project notes"`
(`kit prepare-restart` alone covers one project: the one for its cwd, else the first in kit.config.json).

## Verify

```sh
podman logs --since 10m <container> 2>&1 | grep kanban-entrypoint
```

After a start: `start hook (detached): '/root/.kanban/bin/kit boot'` and `started pid <n>: kanban ...`. After a
stop (`podman logs` still works on the stopped container): `SIGTERM: pre-stop ...`, `pre-stop hook done` (or
`timed out` / `failed`), `restart prepare done` (or `timed out` / `failed` / `skipped`), `forwarding SIGTERM`, `pid <n> exited with status ...`; after `kanban restart update` also `exit 75: Kanban asked for an update restart`. The same lines plus the hooks'
output are in `/root/.kanban/logs/kanban-entrypoint.log`, which survives the container being replaced (auto-update);
`kit boot` also writes `/root/.kanban/logs/kit-boot.log`. `podman inspect <container> --format
'{{.Config.StopTimeout}}'` should print 90.
