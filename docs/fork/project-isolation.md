# Project isolation

User requirement (2026-10-07): an orchestrator, and every other agent in a project, works only on that project and
shouldn't even know of other projects. Cross-project orchestration was a one-off exception for the migration. The
sanctioned way for two projects to work together is a message between their orchestrators: each one acts only on its
own board and repo, at the other's request.

Everything here is off by default (`isolation.mode: off`): with every workspace off, the Kanban CLI is not scoped
at all and behaves as before. Only the project-list rule below applies in every mode.

## Modes

`isolation.mode` (machine-wide) and `workspaces.<id>.isolation.mode` (null = the machine-wide one):

- `off`: nothing changes. Sessions still get a credential, so the project-list rule and messages work. The CLI
  installs no scope and doesn't ask the server who it is.
- `report`: every reach of a session outside its project is logged to `<home>/data/<ws>/isolation.jsonl`. Nothing
  is refused and launches are unchanged. Use it first to see what `enforce` would refuse.
- `enforce`: the runtime API and the Kanban CLI refuse other projects to the session, and its launch gets the
  isolation denies its CLI can express.

A reach from workspace A into B follows the stricter of A's and B's modes, so a project in `enforce` is protected
from the sessions of a project that is `off`.

## How a session proves which project it belongs to

Every agent launch through `runtime.startTaskSession` (cards, the orchestrator's sidebar session and the watchdog's
start of it) gets a random per-launch credential in `KANBAN_SESSION_CREDENTIAL`, plus
`KANBAN_SESSION_WORKSPACE_ID` (informational). The server keeps credential → (workspace, task, role, agent, cwd) in
memory only. A live session handed back unchanged (the session manager's own `active && isActiveState` check,
`willReuseLiveSession`) keeps its credential, and every new process gets a new one. The Kanban CLI sends the
credential on every runtime call (`x-kanban-session-credential`). The watchdog's headless orchestrator runs get one
too (watchdog actions `issueOrchestratorCredential` / `bindOrchestratorCredential`), bound to the run's pid.

A credential is only good from its own session's process tree. The server traces the loopback connection to the
calling process (`/proc`, the reaper's reader) and checks that its parent chain reaches the session's root: its PTY
child, or a headless run's bound pid. A credential used from anywhere else, a forged one, or one of a session that
has ended makes the caller *unknown*, which is refused wherever isolation applies and is never the user. Credentials
of ended sessions are dropped every 10 s (at most 500 are kept). Without `/proc` (not Linux) a live session's
credential is taken as is.

- The name avoids KEY, SECRET and TOKEN: Codex 0.160's shell tool drops env vars matching `*KEY*`, `*SECRET*`,
  `*TOKEN*` by default (checked in the installed binary).
- Cline 3.x runs every card's tools in one hub daemon (`--cline-hub-daemon`) with the first card's env. A Cline
  call from inside a Cline PTY tree is that session's. A call from the daemon is the session whose cwd contains the
  calling process's cwd, read from `/proc/<pid>/cwd` (never from a header), always with the card role: the daemon
  never acts as the orchestrator. A cwd that matches no session is unknown.
- A call without a credential is the user's (the browser, the user's own shell). The exceptions are grants, approvals,
  project changes, and every call while some workspace is in `enforce`: for those the server walks the calling
  process's parents up to a session's root. A process that left the tree (a daemon reparented to init) isn't found,
  so "no credential and no session above it" is not proof of the user: grants and project changes also need the
  user-only code below.
- `hooks.ingest` (every tool call) never resolves the caller: it is validated by ownership instead (the task must be
  a session of that workspace's terminal manager, and a home-agent session id names its own workspace).

Isolation is a guard against an agent's ordinary command forms, like the card guardrails, not a sandbox. The agents
run as the same uid as the server.

## What is scoped

- **Runtime API** (`src/trpc/app-router.ts`): every workspace-scoped procedure checks the caller's reach. A session's
  call without a workspace header gets its own workspace, never the server's active one. `projects.list` shows a
  session only the projects it may reach. Machine-wide procedures are refused to sessions under `enforce`:
  `runtime.saveConfig`, `resetAllState`, `runUpdateNow`, `runProcessSweep`, `projects.pickDirectory` and
  `listDirectoryContents`. So are WebSocket upgrades (board stream, terminals) to another project.
- **Kanban CLI** (`src/isolation/cli-scope.ts`, cli.ts preAction): while some isolation is on, a CLI with a session
  credential scopes its in-process board access. Other projects in `enforce` drop out of every listing and can't be
  opened; a task worktree resolves to its project. Reads under a grant are logged as `grant_used` on both sides. The
  hook commands are never scoped.
- **Watchdog**: a board's wake goes to its own orchestrator only. Under `enforce`, `orchestrator.wake.target` is
  ignored (the wake goes home; under `report` the decision log says it *would*), and wakes go to the sidebar session
  instead of a headless run: a headless run carries its workspace's credential but no isolation guardrails. The
  server checks it too: an action for B's board can't type into or start A's orchestrator (`fromWorkspaceId`,
  `src/server/watchdog-actions.ts`).
- **Launches**: other projects' checkouts, worktrees, Kanban data (`data/<ws>`, `workspaces/<ws>`, board backups)
  and Claude project dirs are denied for reads and writes. The machine-wide config is denied for writes, for file
  tools and, for Claude Code and Cline (Kanban's command matcher), for shell writes too: a redirect into it, or any
  program but a read-only one (`cat`, `jq`, `grep`, ...) naming it. The system prompt and the launch note name only
  the session's own project.
- **ATTENTION.md, decision logs, scoreboard**: they live under `data/<ws>/`, which is denied to other projects. Wakes
  only carry their own workspace's paths.

Per agent (checked against the installed CLIs on 2026-10-07; `kanban doctor` area `isolation`):

| Agent | Reads | Writes | Level |
|---|---|---|---|
| Claude Code 2.1.292 | `Read(//<dir>/**)` deny + Bash guard on named paths | `Edit` deny (other projects, machine config) + Bash guard (paths, config writes) | partial |
| Cline 3.0.69 | PreToolUse guard: `read_files`, `run_commands` naming a path | guard: `editor`/`apply_patch`, `run_commands` (paths, config writes) | partial |
| Copilot 1.0.92 | prompt (no read permission kind) | `--deny-tool write(...)` (file tools) | partial |
| Codex 0.160.1 | prompt | prompt (no path rules; sandbox can't run in the pod) | prompt-only |
| Gemini, OpenCode, Droid, Kiro | prompt | prompt | prompt-only |

The runtime API check is the same for every agent, and is *partial* too: it holds for the agent's ordinary commands,
not for a process that leaves its session's tree. The orchestrator gets no card guardrails. Under `enforce` it gets
only the isolation denies, and it keeps working anywhere in its own project and its cards' worktrees.

## Machine-wide things

Kanban's `config.json`, kits and workspace index, and the agents' user-level config (`~/.claude/settings*.json`,
`CLAUDE.md`, agents/commands/skills/hooks, `~/.claude.json`, `~/.codex/config.toml`, `AGENTS.md`, rules,
`~/.copilot/config.json`, `mcp-config.json`, Cline's settings, rules and hooks) are changed by the user, or by
`kanban` commands the user runs. Under `enforce` a session can't edit them where its CLI can express it, and these
commands are refused from a session: `config import-kit`, `kit apply`, `setup`, `home migrate`, `doctor --fix`,
`models providers`, `models prices sync`, `restart`, `pipeline import-legacy`, `board restore`. Read-only commands
(`doctor`, `kit show`, `config show`) keep working, scoped to the session's project.

Kanban has no command that changes an isolation mode, so a change is an edit of config.json. The server notices every
change it reads (config is re-read at most every 2 s) and logs it, old → new, as `mode_changed` in every affected
workspace's `isolation.jsonl` and on its console. Who made the edit isn't known to Kanban.

## Projects are the user's

Creating, registering and removing projects is done by the user through Kanban's UI or CLI. Every agent session is
refused, in every mode: tRPC `projects.create/add/remove` and `kanban project add|create`, plus in-process
registration (`kanban task create --project-path <new repo>`). Re-registering the session's own project is a no-op
and allowed. A message can't get around this: the receiving orchestrator is refused the same way.

While some workspace is in `enforce`, the user's own changes need the console code (next section) too, because a
reparented agent process looks like the user: `kanban project add|create` asks for it before it writes, and a
browser add/create/remove is refused with the approval id to complete. A passcode-authenticated browser (remote mode)
is the user and needs no code. Re-adding an already registered project (`kanban task create` does it on every call)
changes nothing and needs none.

## Escape hatch (the user only)

    kanban isolation grant --project <p> [--session <task id>|orchestrator] --reach <q...> [--minutes 60] --reason "..."
    kanban isolation approve <approval id> <code>
    kanban isolation grants | revoke <id> | status

`kanban isolation grant` only works from the user's own terminal with a second factor no agent session sees: the
server holds the grant as a pending approval and prints a one-time code (8 characters, 10 minutes, 3 tries) on its own
console only: the terminal that started Kanban, or `podman logs` for the container. No API, log file or session
output carries it. On a terminal the command asks for the code; otherwise complete it with
`kanban isolation approve <id> <code>`. The server refuses grants and approvals from agent sessions and unknown
callers, and the CLI refuses `grant`, `approve` and `revoke` inside a session. Nothing an agent can set (config,
messages, env) turns this on or off.

A plan card's approval (`kanban plan approve`, `plan expand --approved-by-user`, the board's Approve plan) uses the
same code in every isolation mode, `off` included (docs/team/WORKFLOW.md §13): the user's alone, refused for every
agent session.

A grant lets one session of a project reach the named projects for up to 24 h. Its API and CLI access applies
immediately. Its file denies are dropped at that session's next launch. Grants live only in the server's memory and
end at a restart. Every grant, use and revoke is logged on both sides. The server refuses grants from agent sessions
(credential or process tree, whatever the mode), and the CLI refuses the command inside one. The user's own shell
is never scoped, so a one-off cross-project command is just the user running it.

## Orchestrator messages

    kanban message send --to <project> --text "..." | --text-file <f>
    kanban message inbox
    kanban message reply <id> --text "..." [--refuse]

- Addressed by project (workspace id, configured name or unique repo directory name), never by path.
- Only an orchestrator session sends. The server takes the sender's workspace from its credential.
- Both projects must allow messages: `workspaces.<id>.isolation.messages: "allow"` (default `deny`).
- Plain text up to 4000 characters, control characters stripped. Nothing runs on arrival: the receiver's live
  orchestrator gets a fixed notice (ids and project names only) and reads the text with `kanban message inbox`.
- The notice is queued and typed in only once that orchestrator's Review has settled (`isReviewSettled`) and nothing
  was typed into its TUI since the last Enter, so it never joins a draft the user is writing; one notice per settled
  Review. `send` never waits for it. Sends are limited to 5 per sender → receiver pair per 10 minutes.
- A message is a request, never authority or approval. The receiver may answer or refuse, and its guardrails and
  isolation don't change.
- Each message is logged on both sides (`data/<ws>/messages.jsonl`); refused sends go to `isolation.jsonl`.

## Turning it on

1. `"isolation": { "mode": "report" }` in config.json, then read `data/<ws>/isolation.jsonl` for a day.
2. Remove `orchestrator.wake.target`, and allow messages where two projects work together.
3. `"mode": "enforce"`, then restart the sessions so they launch with the denies (`kanban doctor`, area `isolation`).

## Rolling back

An older Kanban build rejects the `isolation` keys in config.json (`isolation`, `workspaces.<id>.isolation`).
Remove them before rolling back to a build without project isolation.
