# Packaging vs install state, and a node-user migration (2026-10-13)

## Main finding

Implementation follow-up (2026-10-14): lifecycle now exports the canonical KANBAN_HOME/--home choice, bootstrap is
explicit `kanban setup`, no project can administer the instance, the image runs as node with image-only updates,
and home migration includes kits/secrets/vendor. See `docs/fork/instance-configuration.md`. The inventory below
records the pre-change audit and the existing installation's migration constraints; no live mount/UID migration
has been performed.

The npm global location is already suitable for a non-root runtime. The image builds as root and installs Kanban
and the agent CLIs into `/usr/local/lib/node_modules`, with commands in `/usr/local/bin` (`deploy/Containerfile:36-51`).
The installed container's `node` user can execute Kanban 0.1.70-fork.9, Codex 0.162.1 and Cline 3.0.71 from that PATH.
There is no need to move global packages into the runtime user's home or extend PATH with a home bin directory.

Building packages and executing packages are separate permissions. Install global packages as root during the
image build (optionally make `--prefix=/usr/local` explicit), then run the application as `node`. Project installs
and the npm cache belong to writable project/user directories; runtime global package updates should use the
image update path instead of creating a second installation in HOME.

## Boundary inventory

| Concern | Current owner and location | Assessment |
|---|---|---|
| System tools and globally installed CLIs | Containerfile, `/usr/local` and apt-managed `/usr` | Correct packaging boundary; root at build time does not require root at runtime |
| User/agent configs in a fresh image | Only generic base-image shell skeletons and root's npm build cache were present | Provider credentials/model lists are not baked into this image; remove npm build cache from the final image |
| Container start/stop and restart prepare | `deploy/kanban-entrypoint.sh` | Appropriate lifecycle wrapper, but its legacy kit path defaults to `/root/.kanban` rather than the running user's/explicit Kanban home |
| GitHub npm/git authentication bootstrap | Entrypoint writes `~/.npmrc` and runs `gh auth setup-git` on every start | Per-install user configuration is mixed into the central lifecycle entrypoint, even when its command is unrelated to Kanban |
| Quiet npm settings and Claude user instructions | Explicit `kanban setup`, `src/setup/machine-setup.ts` | Appropriate per-install setup; plans changes and preserves user settings |
| Provider credentials and Cline model records | Explicit `kanban setup-provider`, files under the CLI's user data dir | Appropriate per-install state, backed up/atomically written; do not seed it in the image |
| Automatic Lemonade context sync | Server monitor, changes context fields of already-listed models only | A deliberate runtime exception, not packaging; preserve its narrow scope and configurability |
| Hooks, launch rules and folder trust | Agent adapters, Kanban-home hook files and per-card worktrees; trust entries in user configs | Runtime launch state, not image contents; path-sensitive during a HOME migration |
| Default models | `agentDefaults` in the install's config.json | Per-install choice; a GUI select must discover agent choices rather than turn a shipped model list into routing policy |
| Routing presets | Bundled `kits/presets/*.json`, project opt-in and overrides | Portable examples/defaults when explicitly chosen; distinct from populating an agent's personal config |
| Provider-setup authorization workspace | `DEFAULT_PROVIDER_SETUP_WORKSPACE_ID = "kanban-2uge"`, pipeline-config.ts | A specific install's workspace id is packaged as a default; a future cleanup should default to user-only unless explicitly configured |
| GitHub doctor diagnostic | github-auth-checks.ts names `/root/.config/gh` | Root-specific diagnostic; should resolve the real user/XDG/gh config location |
| Binary updates | Image disables Kanban/Cline/Claude auto-update, but Droid remains enabled and Copilot supports its own updater | Image-only updating is not enforced consistently; on-demand Kanban update can still attempt a global npm install |

The entrypoint's auth setup and `kanban setup` both write user npm configuration through different paths. They
currently manage different keys, but lifecycle, bootstrap and explicit setup have no single ownership boundary.
Prefer an explicit per-install bootstrap/setup operation; keep the central entrypoint focused on lifecycle.

The legacy kit executable is absent from this install now. Automatically running it merely because it exists
is still baked into the image, and that discovery ignores the child's `--home` until the separate restart-prepare
environment is exported. Legacy hook behavior should be explicit install configuration, not a root-path heuristic.

## Verified node-user blockers

This is a rootless Podman pod. The current bind mounts are:

- `/mnt/media/projects` → `/projects`
- `/mnt/media/kanban` → `/root`

Inside the container these directories are owned by `0:0`; the `node` user is `1000:1000`. Read-only checks confirmed
that `node` cannot write `/projects` or `/root`, but can write `/home/node`. It can read/execute the system-global
CLIs, while correctly being unable to overwrite `/usr/local/lib/node_modules`.

Changing only `USER node` would therefore lose access to the existing writable install state and projects, even
though npm's global command location works. The current `/home/node` is not the persistent home mount.

Podman also refused a disposable test container attempting to combine `--pod dev` and `--userns keep-id`:
`cannot set user namespace mode when joining pod with infra container`. UID mapping must be designed at the pod
boundary, not bolted onto just this existing Kanban container. A pod-wide mapping change also applies to the
PostgreSQL/Caddy/Chrome deployment, so validate all service mounts in an isolated pod before the install migration.

## HOME migration is not just a mount rename

Moving the same persistent home from `/root` to `/home/node` changes absolute paths used by:

- Git's registered task worktree `gitdir` metadata;
- saved session `workspacePath` values and runtime state that names scratch/outbox/worktree paths;
- Claude/Codex/Cline history and caches tied to old worktree cwd paths;
- user trust entries, hooks, symlinks, SSH/config includes and any explicit root paths in agent configs.

`kanban home migrate` is a Kanban-state copy/worktree-move command, not a complete user-home remapping tool.
Its inventory currently copies workspaces/hooks/trashed patches/data and selected top-level files plus the server
start record. It omits user `kits/`, `secrets/` (including the GitHub App key), `vendor/` and the separate agent home
directories. It rewrites session paths only for worktrees it moves. Do not assume it alone covers a root→node user
migration, or invoke it between two aliases of the same bind-mounted directory as if those were separate homes.

## Recommended next step

1. **Packaging cleanup:** keep root-only apt/npm installation in the build; pin global prefix to `/usr/local`,
   clear build caches, and make entrypoint paths user/Kanban-home-aware. Split auth/bootstrap and legacy kit hooks
   into explicit per-install operations. Audit every agent updater against the image-only update rule.
2. **Non-root image validation:** run fresh disposable containers as `node`; check each CLI, npm project installs,
   native PTYs, home initialization, provider setup, and the full start/stop/restart-prepare path. No global npm
   installation should be needed at startup.
3. **Install migration:** test the pod's UID mapping and writable mount layout on copies of state. Preserve the
   entire agent/user home and Kanban's user kits/secrets/vendor data; deliberately migrate or retain old absolute
   worktree/history paths. Validate the other pod services under the proposed mapping.
4. **Switch the live install:** make the migration and Quadlet mount/user settings an install-specific step, then
   set the image's normal runtime to `node`. Binary PATH remains `/usr/local/bin`; HOME becomes `/home/node` (or an
   explicitly configured writable home), and Kanban home continues to resolve through its existing home resolver.

No live UID, mount, ownership or home migration was performed during this audit.
