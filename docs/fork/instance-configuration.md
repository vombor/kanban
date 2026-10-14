# Product packaging and instance configuration

The image contains executable product code and tools. A fresh instance starts with **zero projects**. Creating its
first project gives it the same permissions as every later project; no workspace is an administrative workspace.

## Ownership

| Owner | Contents | Location |
|---|---|---|
| Product image | Kanban, agent CLIs, git, gh, native PTY dependencies, bundled opt-in kit templates | `/usr/local` and `/usr` |
| Kanban instance | Boards, sessions, worktrees, defaults, configured providers, user kits, GitHub App key, vendor tools | `KANBAN_HOME` |
| Agent/user tooling | Agent credentials and histories, npm and git config, gh login, SSH keys | Each tool's HOME/config-directory rules |
| Project | Repository and project-owned files | A configured projects root (`/projects` in the image) |

`--home <dir>` wins over `KANBAN_HOME`. Without either, the canonical resolver chooses the running user's
`~/.kanban`. The entrypoint exports the resolved `KANBAN_HOME` to its child and lifecycle hooks, including a
`--home` override. TypeScript uses the helpers in `src/state/kanban-home.ts`, not a new local path construction.
Literal `~/` is display/input notation; use a resolver or `$HOME` when an actual filesystem path is needed.

Kanban never relocates Cline's data, Claude/Codex/Copilot history or npm/git settings into `KANBAN_HOME`. Their own
directory overrides still apply. A provider endpoint and model list are instance settings, never image seeds.

## Explicit bootstrap and administration

Run `kanban setup --dry-run` to inspect instance setup, then `kanban setup` to apply it. With `GH_TOKEN` (or
`GITHUB_TOKEN`), it adds npm's literal environment-variable reference and configures a missing git credential
helper through gh. Existing user values are preserved; no token is printed or embedded in npm configuration.
Container startup performs neither operation and never auto-discovers a legacy kit executable.

`setup`, `setup-provider` and `restart update` are user-only in every isolation mode. No project's orchestrator or
card can run them. The removed `providers.setupWorkspaceId` is ignored during compatibility reads, grants no
privileges, and is removed by `kanban doctor --fix` or a config migration.

## Non-root image

Global packages are installed as root at **build time**, explicitly into `/usr/local`. The image's normal runtime
is `node` (uid 1000), with agent/user HOME `/home/node`. Projects and HOME mounts must be writable by that user.
An independent Kanban state mount can be selected with `Environment=KANBAN_HOME=/var/lib/kanban` in a Quadlet.
The product owns no assumption about the host paths backing these mounts.

The image disables every packaged agent's self-updater. `KANBAN_UPDATE_MODE=image` also prevents `kanban update`
from replacing the image's global package: use `kanban restart update`. CI runs the disposable
`scripts/container-smoke.mjs` before publishing an image: no host home/projects mounts, no credentials, no network;
it verifies CLI execution, project npm installation, native PTYs, project-free startup, explicit setup, custom
`KANBAN_HOME`, first-project creation and graceful restart preparation/shutdown.

## Existing-instance migration

An existing root-based deployment needs an explicit migration before adopting the node-default image:

1. Copy and back up the **whole user home**, Kanban home and project state before changing mounts or ownership.
2. Design UID mapping at the pod boundary; Podman rejects `--userns keep-id` added to a container joining an
   existing infra pod. Keeping the pod's existing mapping and assigning copied Kanban/home/project data to
   container uid/gid 1000 is also viable: use `podman unshare` against canonical host paths, and verify writable
   mounts on copies. That approach can leave sibling services and their data ownership unchanged.
3. Select `KANBAN_HOME` independently from agent HOME. `kanban home migrate` now includes user `kits/`,
   `secrets/` and `vendor/`, with file modes preserved, but it is not a whole-user-home migration tool.
4. Account for absolute worktree metadata, session/history cwd paths, trust entries, symlinks and hooks. Retaining
   an old path deliberately can be appropriate; simply renaming a mount does not rewrite those paths. An
   instance-only compatibility mount and explicit `worktreesRoot` can preserve existing cwd strings while the
   canonical Kanban home moves. Agent conversation/history/token readers may depend on the strings themselves.
5. Stop the old instance, apply the tested mount/user settings, validate the new instance, then resume work.

For an interim deployment that retains the old root-owned mounts, explicitly select uid 0 and its existing HOME
and KANBAN_HOME in that deployment. This is an instance compatibility choice, not the product's default.
