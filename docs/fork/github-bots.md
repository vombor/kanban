# GitHub issues as the Kanban GitHub App

Kanban's agents (dev, QA and plan cards, every orchestrator) file and comment on GitHub issues as **one GitHub App
for the whole machine**, not with the user's PAT. Every post ends with a line naming the Kanban project it comes
from, and the poster's role when known:

```
The link on the settings page is broken.

— notes · orchestrator (Kanban)
```

A GitHub App's name and avatar are fixed (`<app>[bot]`), so the project goes into the text, not the identity. The
line is `github.attribution` in config.json (default `— {project} · {role} (Kanban)`; `{project}` is the workspace
id, `{role}` one of `orchestrator`, `dev`, `qa`, `plan`, `user`), and `github.attributionWithoutRole` (default
`— {project} (Kanban)`) where there is no role: Kanban's own comments, such as the land commenter's.

Scope: issues and comments only. The app has **Issues: read and write** and **Metadata: read**, no webhook and no
events. Commits, pushes, branches and PRs stay as they are (the user's PAT, [github-auth.md](github-auth.md)).

## One-time setup (the user)

1. Start it from the browser or from a shell. GitHub sends you back to Kanban twice (after Create and after the
   install), so the links must use the address *your browser* reaches Kanban on: a tunnel's host name on a phone,
   not the pod's `localhost`.
   - **Browser** (simplest, on any device): **Settings > GitHub App > Create Kanban GitHub App**. It uses the
     address the page is open on, opens GitHub in a new tab (or tap **Open GitHub** if the tab was blocked), and
     shows the app once GitHub sent it back.
   - **Shell**, outside any agent session:

     ```sh
     kanban github bot create            # --name "<name>" to pick another app name, --org <org> for an org's app
     ```

     It prints a link to the Kanban server and says which address it used: `--origin <url>` if given, else the
     address of the Kanban page whose terminal you run it in, else the address your browser last opened Kanban on
     (since the server started), else `http://localhost:<runtime port>`. Pass `--origin <url>` when that's not the
     one your browser uses.

   GitHub opens with the app filled in. Check the name (it must be unique on GitHub; you can change it on that page)
   and click **Create GitHub App**.
2. GitHub sends you back to Kanban, which stores the app and sends you on to its installation page. Pick **All
   repositories** (so every project, present and future, is covered without another click) and **Install**. With
   "Only select repositories", pick each project's repository and `vombor/kanban` (bug reports); `kanban doctor`
   lists any project whose repository isn't covered, with the install link.
3. The logo. GitHub's manifest has no logo field and no API sets an app's logo, so upload it by hand: save the
   Kanban icon from `<your Kanban address>/api/github/app/logo.png` (the file is `web-ui/public/assets/icon-512.png`
   in the source, `dist/web-ui/assets/icon-512.png` in the package; 512×512 PNG, 6 KB, so square and under GitHub's
   1 MB), open `https://github.com/settings/apps/<slug>` and upload it under **Display information**. The page Kanban
   shows after the install, and `kanban github bot status`, give the exact links.
4. `kanban doctor` shows the app, its file's mode and which repositories it covers.

Creating the app is the user's: `kanban github bot create` is in `USER_ONLY_COMMANDS` (refused from every agent
session), and the server's `github.startAppCreation`, which the CLI and the settings dialog both call, refuses any
caller that isn't the user (strict caller lookup). Creating it again makes a new app and replaces the stored one;
delete the old one on GitHub.

## How it works

- **Creation** (`src/github-app/app-manifest.ts`, `src/server/github-app-route.ts`): GitHub has no API that creates
  an app with a PAT, so it is GitHub's [App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest).
  The server keeps a one-time `state` (in memory, 1 h), serves the page that posts the manifest to
  `github.com/settings/apps/new?state=…`, and on GitHub's redirect checks the state and exchanges the code
  (`POST /app-manifests/{code}/conversions`). Only the app's id, slug, owner and private key are kept; the client and
  webhook secrets aren't needed and are never stored. These routes are served ahead of the passcode gate, because
  GitHub's redirect is a cross-site navigation without the `SameSite=Strict` session cookie: the state is what
  authorizes them.
- **The origin** (`src/server/browser-origins.ts`, `src/core/browser-page-origin.ts`): the start page,
  `redirect_url` and `setup_url` all use one origin, and GitHub sends the manifest code to it, so an agent must never
  pick it. Behind a tunnel or a forwarded port the server's Host and Origin headers still say localhost (the host
  and CORS gates allow only that), so only the page knows its address: the web UI names `window.location.origin` as
  `pageOrigin` on the state stream and on every terminal WebSocket. The server keeps it in memory only, and only
  for a browser's upgrade (it carries an Origin header and passed the gates and the passcode) whose strict caller is
  the user: the last page origin, and per terminal the page its latest viewer was open in. When the start names no
  origin (the CLI without `--origin`), the server takes the page of the terminal the calling process runs in (the
  isolation service's `findCallingSession`, the /proc trace of the loopback connection), else the last page origin,
  else `http://localhost:<runtime port>`, and answers which one (`originSource`), which the CLI prints. The settings
  dialog always sends its own page's origin. `github.appStatus` tells the user (not a session) the same choice, for
  `bot status`'s logo link.
- **The key** (`src/github-app/app-credentials.ts`): `<home>/secrets/github-app.json`, mode 0600 in a 0700 dir,
  written atomically. One file for the machine (not per workspace, so `project rename-id` doesn't touch it). Never in
  config.json, a project repo, a log, an error message, or an agent's env or prompt; only the server reads it, to
  sign the app's JWT. Under project isolation `enforce` the secrets dir is denied to every session like another
  project's data. Agents run as the same Unix user, so 0600 keeps it from other users, not from a process that goes
  looking: what keeps it out of an agent's hands is that nothing hands it over. `kanban doctor` warns when the file or
  dir is open to others (`--fix` tightens it), and `scripts/secret-guard.sh` knows the key's lines.
- **Tokens** (`src/github-app/installation-tokens.ts`): the server signs a JWT (RS256, 9 minutes), finds the app's
  installation on the repository (`GET /repos/{owner}/{repo}/installation`; 404 = not installed) and mints an
  installation token scoped to that one repository with Issues write and Metadata read
  (`POST /app/installations/{id}/access_tokens`). Tokens are cached in memory until 5 minutes before they expire.
- **Posting** (`kanban github issue create|comment|edit|close`, tRPC `github.issue`, `src/trpc/github-api.ts`): the
  strict caller lookup decides who posts. A card or the orchestrator of workspace X posts for X (the attribution names
  X and the role: a card's role from `resolveCardRole`), and only to X's own GitHub remotes and `github.sharedRepos`
  (default `["vombor/kanban"]`, for Kanban bug reports). The user posts for the project they name (`--project`, or the
  cwd's), to any repository. Another workspace's session and an unidentified caller are refused in every isolation
  mode, and logged in the isolation log. The answer carries the issue's number and URL, never a token.
- **Which credential** (`src/github-app/issue-writer.ts`): the app's installation token when the app is installed on
  the repository; refused with the install link when the app exists but isn't installed there; the user's PAT (`gh`
  login, `GITHUB_TOKEN`/`GH_TOKEN`) with a one-line warning while there is no app yet, so nothing breaks before the
  setup. Rate limits come back as "try again after <time>".
- **Kanban's own posts**: the land commenter (`issues.commentOnLand`, `src/issues/issue-comment.ts`) uses the same
  writer. Issue import only reads and keeps the PAT (or anonymous).
- **Steering agents** (`GITHUB_ISSUE_DENY_COMMANDS` in `src/guardrails/command-patterns.ts`): every card with
  guardrails and the orchestrator's isolation guardrails deny `gh issue create|comment|edit|close|reopen|delete|…`
  and `gh api {issues-write}` (a REST call under `repos/<o>/<r>/issues` that isn't a GET, or a GraphQL mutation on an
  issue or comment), appended like the plan-approval rail so a configured `denyCommands` can't drop them. The block
  message points to `kanban github issue …`; reading (`gh issue view|list`, `gh api` GETs) stays allowed. Claude Code
  and Cline match `gh api` writes in Kanban's hook; Codex's prefix rules and Copilot's `shell(...)` would deny every
  `gh api`, so there it is a prompt note. The managed CLAUDE.md section tells orchestrators the same.

## The commands

```sh
kanban github issue create  --repo <owner/name> --title <title> --body-file <file> [--label <l>...] [--project <p>]
kanban github issue comment --repo <owner/name> --number <n> --body-file <file>
kanban github issue edit    --repo <owner/name> --number <n> [--title <t>] [--body-file <file>]
kanban github issue close   --repo <owner/name> --number <n> [--reason completed|not_planned] [--comment-file <file>]
kanban github bot create    [--name <name>] [--org <org>] [--origin <url>] [--no-wait]   # the user's
kanban github bot status
```

`--body-file -` reads stdin. Write bodies to a file (a heredoc), never inline in double quotes: backticks in a
body run in the shell.
