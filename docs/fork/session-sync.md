# Session sync (In Progress ↔ Review moves)

The runtime moves a card between In Progress and Review when its task session changes state
(`src/server/session-column-sync.ts`, plan step P2-1). Upstream did this in the browser. The rules:

| Session | Card | Move |
|---|---|---|
| `awaiting_review` (turn ended) | In Progress | top of Review |
| `running` (turn started) | Review | top of In Progress, **unless** auto-review has armed the card (`pendingGitAction`): the reconciler typed the commit/PR prompt and owns the card until Done or until the arming goes stale |
| `interrupted`, `idle`, `failed` | any | none, and never to Done |

A card moves only when the session summary is newer than the card (`updatedAt` guard), so a card someone moved by
hand stays where they put it until the session changes again. Moves happen on every session state change and on
a 10 s sweep, with or without a browser open.

## Setting

`sessionSync` in the Kanban home's `config.json` (the global config path in Settings; on the pod today that
is the legacy home, `~/.cline/kanban/config.json`):

```json
{ "sessionSync": false }
```

- Default: `true` (on) in this fork. The settings dialog never writes the key and keeps it when it saves.
- It is **read once when Kanban starts**. The server's session sync and the browser get the same value from that
  read (the browser through `sessionSyncEnabled` in the runtime config), so they never both move cards or both
  leave them. Editing the file does nothing until the next restart.
- A value that isn't `true`/`false`, or a config.json that doesn't parse, gives the default and a
  `[kanban] sessionSync ...` warning in the server log.

## Turning it off quickly

1. Set `"sessionSync": false` in the Kanban home's `config.json`. Keep the other keys.
2. Restart Kanban: a container restart on the pod (`systemctl --user restart <unit>.service` on the host, when no
   cards are running; see `container-lifecycle.md`), or stop and start `kanban` locally.
3. Reload the browser tab. With the setting off, the browser makes the upstream moves again, including upstream's
   "interrupted → Done" move. A browser tab that was opened before the restart keeps its old setting until it reloads.

Meanwhile, and until its cutover, the legacy kit's column-sync service (`/root/.kanban`) keeps moving cards between
In Progress and Review the way it always did. It doesn't depend on this setting, so turning session sync off leaves
the pod exactly as it was before P2-1.

To turn it back on, remove the key (or set `true`) and restart.

## Next to the legacy kit's column-sync

Both can run at once. They apply the same two rules with the same guard, so they agree on every move. The kit
saves the whole board with `expectedRevision`. If the runtime moved the card first, the kit's save fails with a
conflict, and its next tick finds the card already in place. If the kit moved first, the runtime finds nothing to
do. (`test/integration/session-column-sync.integration.test.ts` covers both orders.)

There is one difference. The kit's Cline-CLI turn-end moves call `hooks.ingest to_review` before moving the card.
If that call fails, the kit moves only the card, and the runtime moves it back once the session summary changes.
So disable the kit's column-sync (`touch ~/.kanban/run/column-sync.disabled`) only after the cline-cli turn detector
(P2-2) is in the runtime.

## Checking it

- A card whose agent finished its turn is in Review within a second, with no browser open.
- An auto-review card stays in Review while the agent commits, then goes to Done.
- `GET /api/trpc/runtime.getConfig` (or the browser's network tab) shows `"sessionSyncEnabled": true|false`.
