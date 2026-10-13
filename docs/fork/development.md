# Developing Kanban (outside the pod)

Since 2026-10-13 (user decision) Kanban itself is developed in a plain Claude Code session in a checkout **outside
the pod**, on the host, pushing to `fork/stack` of `vombor/kanban`. The pod (`ghcr.io/vombor/kanban:latest`, see
[container-lifecycle.md](container-lifecycle.md)) runs only project work: foo, notes, cline-pass-test and the rest.
No card and no orchestrator in the pod edits Kanban's own repo, and the pod picks up a new Kanban only when the user
restarts it.

So the pod-level jobs are the user's alone:

| Job | Command | Why it is the user's |
|---|---|---|
| A model provider's Cline settings | `kanban setup-provider <provider>` ([setup-provider.md](setup-provider.md)) | Cline's models.json and providers.json are shared by every project's Cline cards |
| Moving the pod onto a newer image | `kanban restart update` ([container-lifecycle.md](container-lifecycle.md#updating-from-inside-kanban-restart-update)) | it stops every project's agents |
| Cline's allow list | editing the `models` record of a provider in Cline's models.json by hand ([MODELS.md](../team/MODELS.md)) | Cline offers every project only the models in it |
| Vetting a model for that list | `kanban models vet` ([MODELS.md](../team/MODELS.md#vetting)) | its result decides the allow list |

The authorization code is unchanged: `setup-provider` and `restart update` (`KANBAN_ORCHESTRATOR_OR_USER_COMMANDS`,
`src/isolation/cli-scope.ts`) allow the user and the orchestrator of `providers.setupWorkspaceId` (default
`kanban-2uge`). That workspace isn't registered in the pod any more, so no session there carries its id: the
server allows the user and refuses every agent session, orchestrators included
(`test/runtime/isolation/provider-setup-caller.test.ts`, `test/runtime/trpc/restart-update-api.test.ts`).

## Setting up a checkout

- Node: what `package.json`'s `engines` asks for (`>=22`). The image runs Node 26 and its CI build Node 24, so a
  current release is the safe choice.
- Clone `vombor/kanban`, check out `fork/stack`, then install both packages:

  ```sh
  npm ci
  npm ci --prefix web-ui
  ```

- Read [AGENTS.md](../../AGENTS.md) first: it is the project's tribal knowledge, and most of it is about
  the pod's behaviour, which a change outside the pod still has to keep.

## Before a push

Every push to `fork/**` builds an image, and a push to `fork/stack` becomes the pod's next `:latest`, so a push is a
deploy. Run all of these before pushing:

1. **Secret guard** over the commits being pushed (never prints a secret, only the commit and the kind of hit):

   ```sh
   scripts/secret-guard.sh --scan origin/fork/stack..HEAD
   ```

2. **`npm run check`**: biome (format, import order, lint), the runtime typecheck, the web-ui typecheck and the
   whole vitest suite. Run `npx @biomejs/biome check --write <files>` on changed files first.
3. **The web-ui tests**: `npm run web:test` (`npm --prefix web-ui run test`).
4. **`npm run build` in an exported copy** of exactly what you push, not in the working tree:

   ```sh
   dir=$(mktemp -d) && git archive HEAD | tar -x -C "$dir"
   (cd "$dir" && npm ci && npm ci --prefix web-ui && npm run build)
   ```

   Why: the image is built from the pushed commit, and its `npm run build` runs the web-ui's `tsc --noEmit`, which
   typechecks `src/trpc/app-router.ts` and everything it imports under the web-ui's stricter tsconfig. A router
   import that reaches server code passes every card check and still breaks the image (6ce84a54, a09fe082;
   AGENTS.md has the rule). The export also catches a file the build needs that was never committed.

Never run the suite from inside a git hook, and make WIP commits with `--no-verify` (AGENTS.md: git's hook
environment redirects every git command the tests start).

## Trying a change without the pod

Run a throwaway Kanban from the build, with everything of its own: a temp Kanban home, HOME and projects root, a
free port, and no `KANBAN_*` or `GIT_*` variable from your shell (an agent session's credential, a runtime port or a
hook's `GIT_DIR` would point it at another Kanban or another repo). It is what
`web-ui/tests/mobile/dev-instance.ts` does for the mobile e2e tests.

```sh
root=$(mktemp -d)
mkdir -p "$root/home" "$root/user-home" "$root/projects/demo"
git -C "$root/projects/demo" init -q -b main
git -C "$root/projects/demo" commit -q --allow-empty -m init
cd "$root/projects/demo"
env $(env | sed -n -e 's/^\(KANBAN_[A-Z0-9_]*\)=.*/-u \1/p' -e 's/^\(GIT_[A-Z0-9_]*\)=.*/-u \1/p') \
  HOME="$root/user-home" KANBAN_PROJECTS_ROOTS="$root/projects" KANBAN_NO_AUTO_UPDATE=1 \
  node /path/to/checkout/dist/cli.js --home "$root/home" --port 3600 --no-open
```

- `--home` (or `KANBAN_HOME`) must be the temp dir: never the pod's home (`/root/.kanban` in the pod, or wherever
  its volume is mounted on the host). A second Kanban on the same home would run its own pipeline, watchdog and
  reaper against the pod's boards.
- Pick a port nothing else uses: the pod's server is on 3485, and the default is 3484.
- Agent CLIs read their own config under HOME, so a temp HOME starts them signed out. Copy in only what a test
  needs, and never a token into the repo.
- For the web-ui with hot reload, run the runtime with `NODE_ENV=development` and `KANBAN_WEB_UI_PORT=<vite port>`
  and Vite with `KANBAN_RUNTIME_PORT=<runtime port>` (the runtime accepts the dev server's origin only on that port),
  as dev-instance.ts does.

## How a push reaches the pod

1. A push to `fork/stack` runs `.github/workflows/image.yml`: `npm ci` in both packages, `npm run build`, `npm test`,
   then the image `ghcr.io/vombor/kanban:sha-<short>`, `:fork-stack` and `:latest` (only from `fork/stack`, the
   `LATEST_BRANCH`), with the build stamp (`KANBAN_IMAGE_REVISION`/`KANBAN_IMAGE_CREATED`).
2. The pod's Quadlet unit has `Pull=newer` and `Restart=always`: every start of the container pulls `:latest` when it
   is newer. Nothing in the pod pulls on its own.
3. The user restarts the pod when no card is In Progress: `kanban restart update` from the pod's terminal (it
   refuses without a newer image or while a card is In Progress, runs restart prepare and exits 75 so the unit starts
   it again on the new image), or `systemctl --user restart <unit>` on the host. After the restart the watchdog's
   "Kanban restarted" wake tells every orchestrator which build it came back on.

## How project orchestrators reach the dev session

Through GitHub issues on `vombor/kanban`. An orchestrator in the pod that hits a Kanban bug or needs a Kanban
change searches first (`gh issue list --repo vombor/kanban --search "<words>"`), then comments on the existing issue
or files one with `kanban github issue create --repo vombor/kanban --title "<short summary>" --body-file <file>` (as
the Kanban GitHub App, [github-bots.md](github-bots.md)). The dev session reads them with
`gh issue view <n> --json title,body,comments,labels,state` and closes them from the fixing commit (`fixes #<n>`).

`kanban message` doesn't reach the dev session: its messages stay within one Kanban server (the projects of one
Kanban home), and the dev session is outside the pod's.
