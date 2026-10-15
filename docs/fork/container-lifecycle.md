# Container lifecycle (ghcr.io/vombor/kanban image)

The pod runs project work only; Kanban itself is developed outside it, and how a push becomes the pod's next image
is in [development.md](development.md).

The dev-pod image (`ghcr.io/vombor/kanban`, built from `deploy/Containerfile` by `.github/workflows/image.yml`)
starts Kanban as `node` through `deploy/kanban-entrypoint.sh` (`/usr/local/bin/kanban-entrypoint`). Product/install
ownership and existing-instance migration are described in [instance-configuration.md](instance-configuration.md).
The entrypoint owns lifecycle only:

- **Every start** launches an explicitly configured `KANBAN_START_HOOK` in the background. With no hook it starts
  Kanban directly; it never discovers or starts a kit just because one exists.
- **Every stop** (`podman stop`, `systemctl stop/restart`, `podman auto-update`, host shutdown: all of them send
  SIGTERM) first runs an explicitly configured `KANBAN_PRESTOP_HOOK`, for at most 45 s, then `kanban restart
  prepare` (the runtime's WIP tags and restart manifest for every workspace, with the server's start time), for
  at most 20 s. Both run while Kanban is still up. Then it passes the signal on to Kanban (which shuts down within
  10 s) and exits with Kanban's exit status.
- **Kanban's own update restart** (`kanban restart update`, below): Kanban runs `kanban restart prepare` itself, shuts
  down and exits with status 75. The entrypoint runs no pre-stop step for an exit it didn't signal, logs
  `exit 75: Kanban asked for an update restart` and exits with 75, so the container exits and systemd starts it again.

A missing `kanban`, a failing step, a step that runs past its timeout or a Kanban that is already down
never blocks or aborts the stop: the entrypoint logs one line for it and goes on. A second SIGTERM/SIGINT cuts the
running step short, skips the rest and is passed on at once.

`kanban restart prepare` gets the command's `--port`, `--host`, `--home` and `--https` as `KANBAN_RUNTIME_PORT`,
`KANBAN_RUNTIME_HOST`, `KANBAN_HOME` and `KANBAN_RUNTIME_HTTPS` (a CLI started outside the server would look on the
default port 3484). With an `Exec=` override the entrypoint can't read (`sh -c '...'`), set those in the
container's environment.

The image's command (`kanban --host :: ...`, a dual-stack listener) runs as the entrypoint's child, so Kanban is no longer
PID 2: it sits behind `podman-init` (PID 1) and the entrypoint (PID 2), with a small pid that is about the same at
every start. An `Exec=` override still works: it replaces only the command, and the entrypoint runs whatever it gets.

## Quadlet

The image tag is the pod's channel: `:latest` (every push to `fork/stack`, as below) or `:stable` (the last release,
recommended for a pod that runs projects; see [Releases](#releases)). Kanban's `update.imageChannel` must name the
same tag.

```ini
[Container]
# :stable for a consumer pod (Releases, below); :latest follows every fork/stack push.
Image=ghcr.io/vombor/kanban:latest
AutoUpdate=registry
# Every container start pulls the tag first when the registry's digest differs from the local image (podman run
# --pull=newer; a failed pull falls back to the local image). Together with Restart=always this makes "the container
# exited" = "update and come back" (kanban restart update, below). Quadlet's Pull= key: podman 4.6.0 and later.
Pull=newer
# podman stop's default (10 s) would SIGKILL Kanban while the pre-stop steps run: 45 s hook + 20 s restart prepare +
# 10 s Kanban + margin.
StopTimeout=90
RunInit=true
# The user's classic PAT as GH_TOKEN, from a podman secret (docs/fork/github-auth.md).
Secret=gh_pat,type=env,target=GH_TOKEN
# No Exec= needed. Select Kanban state independently from agent/user HOME.
Environment=KANBAN_HOME=/var/lib/kanban
# Mount your own state, user home and projects with permissions appropriate for node (uid 1000).
Volume=<state-root>:/var/lib/kanban
Volume=<user-home>:/home/node
Volume=<projects-root>:/projects

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
doesn't have to: it only has to exit. `kanban restart update` is user-only. Every project's orchestrator and every
card is refused; no project has special privileges. The server's `restart.update` route uses the strict caller:

1. refuses outside a container (no `/run/.containerenv`);
2. compares the running build (`KANBAN_IMAGE_REVISION`/`KANBAN_IMAGE_CREATED`, set from build args by CI; the same
   values as the `org.opencontainers.image.revision`/`.created` labels) with the labels of the tag the pod follows,
   `ghcr.io/vombor/kanban:<update.imageChannel>` (`latest` by default, `stable` for releases), read anonymously
   from GHCR, and refuses when it isn't newer, the running image has no stamp (a local build) or the registry can't be
   read. On `stable` it names releases: `v0.1.70-fork.8 is out (running v0.1.70-fork.7); release notes:
   https://github.com/vombor/kanban/releases/tag/v0.1.70-fork.8`, `Already on the latest release (…)`, and a running
   build that isn't a release (a `:latest` or branch image) is reported as one;
3. refuses while any card is In Progress in any project (their agents stop with the container; after the restart
   restart recovery resumes them where `pipeline.recovery.mode` is `on`);
4. runs the same restart prepare as the entrypoint's stop step for every workspace (WIP tags + restart manifest),
   with the update recorded in the manifest, answers, and shuts Kanban down gracefully with exit status 75.

`--force` skips 2 and 3 (an unreachable registry, the same image, running cards), `--dry-run` checks and prints
what would happen without tagging, writing or stopping anything. Every request, refused or not, is logged to the
server log and `<KANBAN_HOME>/logs/restart-update.jsonl` (who, the channel, the running build, the channel tag's build
and digest). After the restart the watchdog's "Kanban restarted" wake says `updated from <old build> to <new build>`
(on `stable`: `updated from v0.1.70-fork.7 (…) to v0.1.70-fork.8 (…) (release notes: <link>)`), that the container
came back on the old build (no `Pull=newer` in the unit, or the pull failed), or, on `stable`, that it came back on
a build that isn't a release (the unit's `Image=` names another tag).

Kanban can't check the unit from inside: the Quadlet file is on the host, and a rootless container's
`/run/.containerenv` names neither the unit nor the image. So doctor doesn't warn about a unit without `Pull=newer`
or `Restart=always`. Without `Restart=always` the update restart only stops the container (start it with
`systemctl --user start <unit>`); without `Pull=newer` it comes back on the old image, which the wake then says.
Doctor does check what the running image's own stamp can tell (the "Image channel" row, in a container only): a
release build is never pushed as `:latest` and `:stable` is always a release build, so a release build with
`update.imageChannel` `latest`, or a non-release build with `stable`, is a warning that the setting and the unit's
tag disagree; when they agree it says whether the channel's tag has something newer ("v0.1.70-fork.8 is out (running
v0.1.70-fork.7)" on `stable`). It can't tell `:stable` from a pinned `:0.1.70-fork.7`, and it never claims to see
the unit.

## Releases

The pod is the consumer of Kanban's releases; the producer is Kanban's development, outside the pod
([development.md](development.md), whose "Releases" section points here: the release steps and tags are kept in this
one place). Every
push to `fork/stack` still builds `:latest`, so nothing that follows `:latest` changes; a pod that should run only
what was released follows `:stable` instead.

### Cutting a release (producer)

Run the release skill (`/release` in Claude Code, the `.clinerules/workflows/release.md` workflow;
[RELEASE_WORKFLOW.md](../../RELEASE_WORKFLOW.md) has the details) on `fork/stack`:

1. Collect the commits since the last `v*-fork.*` tag and write the user-facing `## [<version>]` section at the top
   of `CHANGELOG.md` (publish.yml refuses a tag without one).
2. Bump `package.json`'s `version` (`0.1.70-fork.N`) and the two `version` fields at the top of
   `package-lock.json` by hand.
3. Commit (`v<version> release notes`), tag `v<version>`, push `fork/stack`, then push the tag.

The tag push starts two workflows:

| Workflow | On the tag `v0.1.70-fork.8` |
|---|---|
| `publish.yml` | tests, publishes `@vombor/kanban@0.1.70-fork.8` to GitHub Packages (dist-tag `next` for a prerelease version), creates the GitHub release `v0.1.70-fork.8` with the CHANGELOG section |
| `image.yml` | checks the tag is `v${package.json version}` of `@vombor/kanban` (an upstream tag or a mismatch fails the run and moves nothing), builds and tests, pushes `ghcr.io/vombor/kanban:0.1.70-fork.8` and moves `:stable` to it; the build is stamped with `KANBAN_IMAGE_VERSION=0.1.70-fork.8` and the label `dev.vombor.kanban.release` |

The image tags per event:

| Event | Tags pushed | Version stamp |
|---|---|---|
| push to `fork/stack` | `:sha-<short>`, `:fork-stack`, `:latest` | none |
| push to another `fork/**` branch | `:sha-<short>`, `:<branch>` | none |
| daily schedule | the same tags as a `fork/stack` push (a rebuild with the newest agent CLIs) | none |
| tag `v0.1.70-fork.8` (or `gh workflow run image.yml --ref v0.1.70-fork.8`) | `:0.1.70-fork.8`, `:stable` | `0.1.70-fork.8` |

The version tag is metadata-action's semver `{{version}}` form, without the `v`; Kanban names releases with it
(`v0.1.70-fork.8`, the git tag and GitHub release). `:stable` is not rebuilt daily: a release keeps the agent CLIs it
was built with; agent self-updates are disabled at runtime. Re-running `image.yml` on an older tag moves `:stable`
back to that release.

### Following releases (consumer)

1. In the Quadlet file, set `Image=ghcr.io/vombor/kanban:stable`, keeping `Pull=newer` and `Restart=always` as
   above, then `systemctl --user daemon-reload`.
2. Tell Kanban which tag the unit follows: `kanban config set update.imageChannel stable` (the user's command;
   `kanban config unset update.imageChannel` goes back to `latest`). Kanban can't see the unit, so this setting is
   how `restart update`, the wake and doctor know.
3. Move onto the release when no card is In Progress: `kanban restart update --dry-run` says what is out
   (`v0.1.70-fork.8 is out (running …)`, with the release notes link), `kanban restart update` restarts onto it.
   The first switch from a `:latest` build may be refused as "newer than :stable" when `fork/stack` was built after
   the release; `--force` (or `systemctl --user restart <unit>` while no card runs) moves onto the release.
4. `kanban doctor` then shows `Image channel stable: running v0.1.70-fork.8, the latest release`, or a warning when
   the running image doesn't fit the setting.

## Settings (environment)

| Variable | Default | |
|---|---|---|
| `KANBAN_START_HOOK` | unset | explicit `sh -c` command run detached at start; empty = none |
| `KANBAN_PRESTOP_HOOK` | unset | explicit `sh -c` command run on SIGTERM/SIGINT; empty = none |
| `KANBAN_PRESTOP_TIMEOUT` | `45` | seconds; the hook's process group is killed after it |
| `KANBAN_RESTART_PREPARE_HOOK` | `kanban restart prepare` if `kanban` is on PATH | `sh -c` command run after the pre-stop hook; empty = none |
| `KANBAN_RESTART_PREPARE_TIMEOUT` | `20` | seconds; as above |
| `KANBAN_HOME` | `$HOME/.kanban` | Kanban-owned state; the command's `--home` overrides it; also used for lifecycle logs |
| `KANBAN_UPDATE_MODE` | `image` in the image | global package replacement disabled; update through the image |
| `KANBAN_IMAGE_REVISION`, `KANBAN_IMAGE_CREATED` | set by the image | the image's build (commit, build time), for `kanban restart update`; don't override them |
| `KANBAN_IMAGE_VERSION` | set by a release image | the release version (`0.1.70-fork.8`) on a `:stable`/`:<version>` image, empty on every other build; don't override it |
| `GH_TOKEN` | unset | the user's classic PAT. gh reads it; explicit `kanban setup` configures npm/git. Pass it as a podman secret, not `Environment=`. See [github-auth.md](github-auth.md) |

An instance that deliberately retains a legacy kit can set explicit hooks, for example
`Environment='KANBAN_START_HOOK="$KANBAN_HOME/bin/kit" boot'` and
`Environment='KANBAN_PRESTOP_HOOK="$KANBAN_HOME/bin/kit" prepare-restart'`.
The built-in restart prepare already covers all registered projects; none is singled out.

## Verify

```sh
podman logs --since 10m <container> 2>&1 | grep kanban-entrypoint
```

After a start: `started pid <n>: kanban ...`, plus `start hook (detached)` only when one was configured. After a
stop (`podman logs` still works on the stopped container): `SIGTERM: pre-stop ...`, `pre-stop hook done` (or
`timed out` / `failed`), `restart prepare done` (or `timed out` / `failed` / `skipped`), `forwarding SIGTERM`, `pid <n> exited with status ...`; after `kanban restart update` also `exit 75: Kanban asked for an update restart`. The same lines plus the hooks'
output are in `<KANBAN_HOME>/logs/kanban-entrypoint.log` when that directory exists and is writable. `podman inspect <container> --format
'{{.Config.StopTimeout}}'` should print 90.
