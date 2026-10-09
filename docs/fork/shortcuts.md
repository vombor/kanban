# Project shortcuts (the script runner)

A project's shortcuts are the top bar's run buttons: a label, one shell command line and an icon. A click types the
command into a terminal. They are stored in the project at `<project>/.kanban/config.json`, as the settings dialog
always kept them.

## Where a shortcut runs

| Clicked from        | Terminal                    | Directory                                    |
| ------------------- | --------------------------- | -------------------------------------------- |
| a card's view       | the card's detail terminal  | the card's worktree (created if missing)     |
| the board (no card) | the home terminal           | the project's main checkout                  |

That is `runtime.startShellSession` (`workspaceTaskId` → `resolveTaskCwd`), pinned by
`test/runtime/trpc/runtime-api.test.ts`. A shortcut already running in that terminal is interrupted (Ctrl-C) first.
So a Preview shortcut clicked on a card runs that card's code; clicked on the board, it runs the base branch.

## Changing shortcuts without the dialog

```
kanban shortcut list   [--project <path>] [--json]
kanban shortcut add    --label <label> --command "<command>" [--icon <icon>] [--project <path>]
kanban shortcut remove --label <label> [--project <path>]
```

`add` creates the shortcut or replaces the one with the same label (case-insensitive) in its place. Icons:
`play, console, bug, download, upload, build, code, rocket, settings, plus`. The command is one line (join steps
with `&&`).

They go through the running server (`shortcuts.add|remove`, `src/trpc/shortcuts-api.ts`), which looks the caller up
strictly in every isolation mode. The user and the project's own orchestrator may change shortcuts. A card, another
project's orchestrator and an unidentified caller are refused, and the refusal goes to the isolation log. The CLI
refuses `shortcut add|remove` inside a card session itself too. Each change is appended to
`<home>/data/<ws>/shortcut-history.jsonl` (who, from, to). Open boards get a `project_shortcuts_updated` stream
message and reload the shortcuts at once.

The file is in the project repository, so a card can still edit it in its worktree and land it with its work.

## Ports: `{port}` and `{url}`

Any shortcut can ask for a port:

- `{port}` becomes a free TCP port, handed out for that run (a new one on every click, never one another run holds).
- `{url}` becomes `<board origin>/api/shortcut-port/<port>/`, where the browser reaches that port.

A command without either is typed as it is. The browser asks the server to fill them in (`shortcuts.prepareRun`, the
user's click only) just before typing.

Kanban runs in a pod whose only published port is 3485, so a server a shortcut starts in the pod isn't reachable from
the browser on its own port. `/api/shortcut-port/<port>/…` on Kanban's port proxies to that port on loopback
(`src/server/shortcut-ports.ts`). It serves only ports Kanban handed to a shortcut run in the last 24 h. While
nothing listens yet it shows a page that reloads every 2 s.

The app behind it is a card's code on Kanban's origin, so the proxy keeps it away from Kanban:

- every response gets `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups …`, with no
  `allow-same-origin`, so the page runs in an opaque origin;
- the CORS gate lets that page's `Origin: null` through to this path only, never to `/api/trpc`;
- Kanban's cookie and `Authorization` header are not forwarded, and the app's `Set-Cookie` is dropped.

What doesn't work through the proxy:

- URLs the app writes as absolute paths (`/assets/app.js` drops the prefix). Relative URLs work, and redirects to the
  app's own root or `localhost:<port>` are rewritten. `X-Forwarded-Prefix` names the prefix for apps that read it.
- WebSockets (hot reload).
- Cookies and browser storage.
- Behind the passcode gate (remote mode), the sandboxed page's own requests carry no session cookie and are refused.

Inside the pod the port works directly (`curl localhost:<port>`), with none of these limits. To use it from the
browser without the proxy, forward the port yourself (for example `ssh -L <port>:localhost:<port>`, or publish a
port range on the container).

## Example: a Preview button

```
kanban shortcut add --project /projects/notes --label Preview --icon play \
  --command 'echo "Preview: {url}health" && PORT={port} npm run dev'
```

On a card it starts `npm run dev` in that card's worktree on a fresh port and prints a link to `/health`
(clickable in the terminal). The terminal's Ctrl-C (or the next click) stops it, and Done stops what is left in the worktree (the process reaper).
