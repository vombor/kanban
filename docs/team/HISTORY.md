# Team workflow: rules that came from incidents

The dev-team kit (`/root/.kanban`) is being folded into this fork (plan: `docs/fork/kit-merge-plan.md`). Its
history is kept on the orphan branch **`archive/devteam-kit`** (tag `devteam-kit-final`), not merged into
`fork/stack`. Most of the kit's rules were added after something went wrong on the board, and the reason is
only in the commit message. This file indexes those rules so the TypeScript port keeps them.

- Read the full reasoning: `git show <sha>` or `git log archive/devteam-kit -- services/kanban-autoland.mjs`.
- Port commits say `Ported from archive/devteam-kit:<path>@<sha>`.
- Shas below are **archive** shas. Kit commit messages and older docs use the original kit shas (for
  example `cc6ef30`, `3b84abe`); the table at the end maps them.
- Incident references are `<card id> <time> <date>`; all dates are 2026.

## The archive

| | |
|---|---|
| Cut at | kit `main` `a2b46955` (138 commits, 2026-10-07, the kit repo's last commit before it was retired at P5-3). First cut: `0a894c5` (127 commits, 2026-10-06) |
| Archive head | `archive/devteam-kit` = `devteam-kit-final` = `d2e3b3ef3b748e0a27fbba9965443a7a2611d7b2` (131 commits, root `16879d1`). The P5-3 refresh reran the same filter on a fresh clone: it reproduced the first cut's `6da7159` exactly, and the 11 later commits sit on top |
| Removed | `bench/prices-aws.json`, `bench/prices.json`, `bench/model-prices.md` (price data; it goes to `data/prices/`), `kit.config*.json` (`kit.config.json` was never tracked; `kit.config.example.json` dropped). The 7 commits that only touched these files are gone. |
| Moved | `forks/secret-guard.sh` → `scripts/secret-guard.sh` (all of its history) |
| Not in the archive | the kit's other branch `bc84c`: its 2 commits are on main as rebased copies (same patches: `6626852`, `acf45dc`) |
| Secret scans | Key shapes over every blob and commit message: clean. Exact values (`scripts/secret-guard.sh --scan`) over the 11 commits added at P5-3: clean (2026-10-07). The first cut's 120 commits still need the user's exact-value scan (`scripts/secret-guard.sh --scan archive/devteam-kit`) before any push. |
| Pushed | No. Push only after the user's exact-value scan is clean and the user OKs it. |

The rewrite used `git filter-branch --index-filter --prune-empty` on a `git clone --no-local` copy
(`git-filter-repo` needs Python, which this machine doesn't have). Apart from the removed and moved files,
the archive's final tree is identical to kit `0a894c5`.

## Pipeline (was autoland): QA gate and landing

| Sha | Rule |
|---|---|
| `4d41fe5` | QA writes its verdict to a `verdict.json` outbox and the pipeline ingests it; QA cards get no commit/land step of their own (QA isolation). |
| `ddbc9ae` | Review means "submitted". A `BLOCKED` card goes to Backlog, not Review. QA runs in parallel up to `qaSlots`. |
| `8495ed2` | Wait 20 s for `verdict.json` before nudging or recording STALLED (c1e30: the QA card reached Review 0.55 s before its FAIL verdict landed). |
| `cec38c1` | "Does this snapshot still need QA" compares scoreboard verdict times in ms (fast reworks got no QA). |
| `4666e68` | A parked Backlog card with an unhandled verdict is resumed. |
| `ce33433` | Backlog resume ignores verdicts older than a fresh restart (`resetAt`). |
| `a3f076e` | At start, move clean stale worktrees onto the base; the rework text tells dirty ones to bring the base in. |
| `264680f` | postLand rules: `prisma/` changed → `prisma generate` + `migrate deploy` + stop the API (a stale client 500'd master logins). |
| `afea137` | A queued QA card waits while its dev card is In Progress again, instead of starting on the old snapshot (bfb20). |
| `e84c59e` | Snapshot commits use a fixed identity, not the user's gitconfig (a dangling `~/.gitconfig` symlink broke every snapshot, 03:19Z 10/06). |
| `781442d`, `834fbad` | Start the project preview on demand for QA and stop it when QA is idle, only if the pid is still ours; QA cards already In Progress count as active after a restart. (Later removed for foo in `4007b3b`: the shared `:3600` preview is off-limits.) |
| `83aa4d0` | Runoffs: paired bench cards' PASS is held in Review until all have passed or escalated; best mean score lands, losers are tagged `preserve/<id>-<model>` and deleted. |
| `4007b3b` | A runoff closed by hand (Done = trash) has a winner only if exactly one trashed card held a runoff PASS (tier2-coupons 08:51Z: no PASS, 096bd recorded as winner). |
| `2ffe609` | Runoff `benchOnly: true` lands nothing; every PASS is preserved and only the winner is recorded. |
| `b6bbe71` | Reworks copy the QA write-up and artifacts into the worktree (`.qa/r<N>/`, excluded via `info/exclude`; no HTML, nothing over 512 KB). Card agents never need the kit home. |
| `a861b68` | The delayed rework check skips a card escalated since the rework (aa1fe 16:31Z: escalated twice, duplicate scoreboard line). |
| `9052c06` | A chat rework that continues the same Cline session counts as started; a rework already back in Review never escalates as "never started" (6dfa2 19:08Z). |
| `1ce45df` | Hold a Lemonade card's FAIL rework while another Lemonade card on a different model is In Progress (Lemonade loads one model). |
| `6da7159` | Calibration cards (QA-CAL title, calibration prompt, or listed in `calibration/*/state.json`) are one predicate, and every path skips them: startup sweep, Review event, checks, QA, rework, nudge, escalation, land (e5c23: the startup sweep snapshotted it and calibrate's Done landed it). |

## Pipeline: escalation and handback

| Sha | Rule |
|---|---|
| `a1056e9` | Handback is an append-only command (escalation kept in `handbacks[]`, QA-log HANDBACK, `BLOCKED` prefix dropped); it can grant extra rounds and reworks the escalating FAIL once. Hand edits of the state file are refused as tampering (a1593). |
| `158817d` | Continue/nudge/provider-retry budgets restart at a handback (c9e97 re-escalated on its first empty reply after the user's rerun); handback reopens a runoff decided with no winner. |

## Pipeline: recovery (nudges, premature stops, poisoned history, provider errors)

| Sha | Rule |
|---|---|
| `9496770` | A turn that ends on an announcement without a tool call gets "continue", not a QA round. |
| `c09cd4b` | Context-overflow errors are poisoned history: `/clear` + full prompt, not "continue" (de30c: `ls -R` over `node_modules` overflowed a 131k context; "continue" re-sent it). |
| `0a3d1fc` | Overflow nudges name the oversized tool call and clean gitignored reports; Cline rule `bounded-output.md` (its search tool ignores `.gitignore`). |
| `55444d4` | A Review arrival from column-sync after a chat-resumed Cline session is a normal finish (no error nudge). |
| `c5c42ec` | A Review arrival whose Cline session file is still being written (< 2 min) is a false flip (bfb20). |
| `dc6e70d`, `9091f4b` | Don't move a live-session Review card back (it looped with Kanban, 03:06Z); hold QA while the session is live and pick it up in the sweep when it ends (no board event fires then). |
| `894c189` | Clear the live-session hold before the error nudge (a provider-error path left it set; the sweep looped every second, 8e891 06:05Z). The startup sweep skips running/held/retrying Review cards (it QA'd 8e891 mid-work). |
| `ebde195` | Read why a Cline card stopped from Cline's runtime events (`hooks.jsonl`: agent_error/abort/end) before Kanban's summary. `STATUS:` line rule for every Cline model: DONE → QA, BLOCKED/NEEDS_INPUT → escalate. |
| `fc270f0` | An empty final reply is a premature stop (continue, no QA), also when Kanban wrote no summary (c9e97). |
| `bd4eeff` | On an empty final reply, `/clear` and resend the card prompt; Bedrock rejects the empty message in history (c9e97 04:59Z). |
| `8590bad` | An empty reply at the 4096 output cap is a cut-off tool call; the resend says "split writes"; Cline rule `small-tool-calls.md` (c9e97: 8 "empty" exits). |
| `0f713ad` | A final "model doesn't support the image field" reply is poisoned history: `/clear` + resend with a no-images note (aa1fe 16:29Z). |
| `28b04a1` | Run the premature-stop / poisoned-history check also when Kanban's summary still says running with no reviewReason (a2cbb 20:14Z: QA'd an unfinished snapshot). |
| `daf86a5` | Provider errors (5xx, temporarily unavailable, 429) get a backoff retry (1, 2, 4, 8 min, QA held) outside the `NUDGE_MAX` budget (0789a escalated after three 5xx in 25 s). |
| `519d05f` | Provider stream timeouts are transient (two cards stalled at once, 01:43Z). |
| `0bc6387` | A final reply that is a bare provider error ("The operation timed out.") ends the turn and gets the transient retry (a2cbb). |
| `692f174` | Provider-outage hold: when retries are used up on a 5xx, hold the card in Review and probe the model every 5 min; resume after 2 good probes in a row, escalate after 6 h (096bd: escalated twice on a Mantle outage; one good probe was a flap). |
| `6698365` | The outage hold probes Lemonade via `/health`; "connection refused" is transient. |
| `0261b20` | Cancel a hung model request (session running, reply owed, no writes for `HUNG_MIN` 15 / `HUNG_FIRST_MIN` 30 on Lemonade's first call) with Esc, then retry/outage hold. |
| `0ce3398` | CLI error messages drop Node deprecation warnings and include stdout (a1593 escalated with only a DEP0205 warning as the reason). |
| `603394f` | Retry task start once after 10 s when a rework restart fails (a1593 03:35Z). |

## Pipeline: Kanban / container restart recovery

| Sha | Rule |
|---|---|
| `a7d9a76` | A lost Cline start config after a restart is a send failure, not ok (096bd/8e891/c9e97 04:44Z: ok:true and nothing ran). |
| `219fc1b`, `894c189` | Resume a dead Cline card: WIP tag, `/clear`, start with the card prompt; add the WIP note only when the worktree has changes (a note on a clean c9e97 made the agent search other worktrees). |
| `8a1bf34` | Detect a new Kanban start time; cards whose sessions predate it are orphans (no QA/snapshot/nudge/escalation while marked); resume dev cards one at a time, 20 s apart, on the same model, waiting out PID pressure; recreate mid-run QA cards for the same snapshot. `prepare-restart` / `recover-restart`. |
| `1a7a32a` | A Cline CLI session idle after a final reply is finished work, not an orphan; cline 3.x never marks sessions completed (f496b moved back to In Progress at the 11:15Z restart). |
| `6626852` | Nothing of the kit ran at a container start (host reboot 18:31Z, services down until 18:56Z): `kit boot` waits for Kanban then starts the services; `kit start` holds a lock (6 concurrent starts gave 2 column-syncs). |

## Session sync (was column-sync)

| Sha | Rule |
|---|---|
| `bf94846` | A Cline card with no Kanban session summary moves In Progress → Review from the completed session file (6438b/8638b sat unseen; Kanban stopped writing Cline summaries ~10:01). |
| `d21ad72` | …and Review → In Progress when the session file runs again (B-kimi got 3 nudges in 3 min while running). |
| `17ac007` | A Cline CLI card moves to Review when its newest session is idle after a final reply with a `STATUS:` line and no tool call (20 s quiet); some providers never fire TaskComplete (ebe38, Lemonade). |
| `86bee13` | The running → in_progress rule must not undo that move; Kanban keeps reporting the open TUI as running (ebe38 bounced back 2 s later). One shared turn-ended check. |
| `e3ab46f` | Any idle final reply, STATUS line or not, stops the bounce (f496b 15:39Z). |
| `67a0c44` | A QA card's idle final reply moves it to Review without a STATUS line (QA ends with "QA <id> round N: …"). |
| `9675b6f` | A turn that ended before a bounce back to In Progress moves to Review after 5 quiet min (10a60: the bounce made `updatedAt` newer than the final reply; the PASS never landed). |
| `922b5b8` | A Cline 3.x session left "running" on a "no images" rejection is a finished turn after 2 min (a2cbb sat 15 min). |
| `acf45dc` | End the turn in Kanban (`hooks.ingest to_review`) before moving the card, or an open web UI moves the "running" card straight back (calibration QA cards bounced every 5 min from 18:02Z). |

## Watchdog (was review-watch)

| Sha | Rule |
|---|---|
| `8716bcb`, `2e78c2a` | Wake the sidebar orchestrator, not TRIAGE cards; via terminal input + Enter (the chat API doesn't reach the sidebar). |
| `6dc9a6e`, `3db96d0` | Headless orchestrator runs; drop queued issues already cleared from `ATTENTION.md` before a follow-up run. |
| `354466a` | Keep the orchestrator's "## Orchestrator: needs the user" section when rewriting `ATTENTION.md`. |
| `4237849` | An In Progress card with a dead session gets one LLM-free continue after 5 min before the orchestrator is woken (de30c: a nudge silently started no session). |
| `4e426fc`, `3e47f52` | PID pressure: flag at 85% of `pids.max`; tiers: 75% holds new work (QA cards, calibration waves), 90% brownout pauses running agents once. |
| `d9aaa7c`, `a5a5cce`, `d6c88c2` | Under PID pressure: no plan/idle wakes; the one LLM-free continue still runs (only brownout blocks it; bfb20 sat 31 min); a QA card held by pressure counts as QA for the review-stall check (bfb20: woken for "no QA card"). |
| `22f8068` | An escalated (`BLOCKED`) Backlog card is not an idle pipeline head (a1593 reported twice). |
| `b52a684`, `a3b78a4` | No review-stall wake and no cooldown re-wake for a card that is an open `**id` item in "needs the user" (096bd 05:02Z, c9e97 05:52Z). |
| `4007b3b` | No "pipeline idle" re-wake when every waiting card is an open user item. |
| `6f6f826` | A runoff-held PASS for the current snapshot is not a review stall (f496b 16:22Z). |
| `8a4f437` | A Backlog card created in the last 10 min (`NEW_CARD_GRACE_MIN`) is not pipeline idle (6dfa2: woken 51 s after the sidebar created it). |
| `01df7bb`, `760fd36` | Prune Done cards older than 3 days after a backup + index, hourly (153 Done cards = 1 MB `board.json`; the board stopped loading on the user's phone). Skips undecided runoffs and running calibrations. |
| `0782636` | Every Kanban workspace repo is pre-trusted for Claude Code/Codex, keyed by the **main** repo root (a trusted parent doesn't count); Claude/Codex cards stuck on a trust or permission dialog are flagged, never answered (the trust dialog defaults to "No, exit"). (Kit `cc6ef30`.) |

## QA prompt and QA cards

| Sha | Rule |
|---|---|
| `5a6c1ba` | QA uses a seeded DB in the scratch copy and scripted end-to-end journeys; a UI card can't PASS with the visual check blocked (recorded as STALLED). |
| `66797d9` | Browser tooling runs from the project with `--target <scratch>` (v3 screenshotted master); no `preview:stop` (it stopped the shared preview); stop scratch servers after ingest. |
| `359a871` | Diff the snapshot against its merge-base (three-dot), so commits landed on base after the card started don't read as reverts (bfb20 false FAIL). |
| `6db784f` | Blocking issues need quoted evidence and one rerun (calibration v5: a false blocker). |
| `ef523b2` | QA model by the dev card's vendor (`qaRoutes`): OpenAI-built cards get Haiku 4.5 on Cline plus a "drive the changed path" step. |
| `b9dd99b` | QA nudges quote why `verdict.json` is unusable (invalid JSON / unknown verdict); GLM wrote raw newlines and was nudged 6× as "not written". |

## Runtime client (kanban-runtime, kanban-cli)

| Sha | Rule |
|---|---|
| `28a2e5e` | `sendChatMessage` falls back to PTY input + Enter for Codex/Claude cards. |
| `55444d4` | Fall back to `kanbanUrl` when `runtimeUrl` (Caddy) refuses. |
| `760fd36` | Card model comes from `agentSettings` (fork #592) before `clineSettings`, and resume sends both (the fork's `startTaskSession` strips `clineSettings`: resumed cards started on the default model). Typed PTY input is confirmed by session activity, one retry. Run the `kanban` on PATH, never `npx -y kanban` (could fetch upstream). |
| `056e2fc` | The Cline agent id is `cline` on fork ≥ 3 and `cline-cli` on forks 1–2; read it from `kanban --version`. |
| `ebd5434` | Copilot cards need PTY input with a focus-in escape. |
| `8e2fb5c` | Capture CLI stdout via a temp file; the CLI cuts piped output at 128 KiB (prune failed on a 350 KB Done list). |

## Calibration and benchmarks

| Sha | Rule |
|---|---|
| `d648e67` | DNF a run on a tool-call loop (25 of the last 60) or past a $10 cost cap (Nova 2 Lite looped 75 min / $64.84). |
| `1be18d1` | DNF a Cline run with 0 native tool calls after 2 nudges (Devstral on Lemonade wrote tool calls as text). |
| `9bf260c`, `9101a29` | Don't start a Copilot run while signed out; a run with no `events.jsonl` after 10 min is DNF "never started" (3 × 60 min DNF; the fork's trust-folder write had wiped the login). |
| `d006846` | Measure Codex cards from their rollout files (cwd = card worktree; per-turn tokens incl. cache). |
| `38f7227` | Local `-GGUF$` models cost $0 (pinned). |
| `d803265` | The Lemonade model list given to Cline is filtered to tool-calling models (a coding card must never land on Flux/Whisper/kokoro). |

## Machine setup and secrets

| Sha | Rule |
|---|---|
| `00a1c0d` | `secret-guard.sh` pre-push hook: blocks key-shaped strings and this machine's actual secret values; never prints them. |
| `00325b6` | The `sk-` shape must start a token ("task-agent-settings-fields" blocked a push). |
| `cb27ad9` | `git worktree add` copies neither `.husky/_` nor `.husky/pre-push`, so every worktree needs the hook installed (pushes from three fork worktrees skipped the guard). |
| `c8552ae` | Mark the cline 3.x TUI promo notices as shown in `cli-notices.json`, or they block the TUI. |
| `accb937` | Stopping a service for state edits needs its `.disabled` file; the bashrc hook restarts it otherwise. |

## Secret guard in this repo

`scripts/secret-guard.sh` is the kit's guard adapted to this repo: it scans the commits not yet on the push
remote (not `origin/main..`), measures each commit against its first parent (so a merge reports what it adds; the kit version missed merges), checks commit messages too, reads `.env` values from `$KANBAN_HOME/data`
(default `~/.kanban/data`), and has a `--scan <rev-list args>` mode for existing history. It is not wired
into the repo's husky config. To use it as a pre-push hook in a clone or worktree:

```sh
printf '#!/bin/sh\nexec scripts/secret-guard.sh "$@"\n' > .husky/pre-push && chmod +x .husky/pre-push
```

Keep `.husky/pre-push` out of commits (`echo .husky/pre-push >> .git/info/exclude`) unless the team decides
to ship it. Each new worktree needs it again (`cb27ad9`).

## Added at the P5-3 refresh (kit commits after the first cut)

| Sha | Rule |
|---|---|
| `715c8a2`, `282507c` | No headless orchestrator run while an interactive session in the project is live (its transcript was written in the last 10 min), follow-up runs included. Issues stay queued and are re-woken after the cooldown (a second run started beside the live kanban-2uge sidebar, 23:51Z 10/06). |
| `15d7fe5` | Retry git on someone else's `index.lock` for 20 s. A land that throws is a land error and escalates; it doesn't vanish in the queue's catch (4018c 10/07: a QA PASS never landed). |
| `9716878` | Cards named in held orchestrator-plan steps (`[wait:]`, `[watch]`, `[user]`) don't count toward a "pipeline idle" wake (4189a 10/07). |
| `3ddf550` | Orchestrator wakes go to one sidebar session, on Kanban's selected agent, with a headless fallback. |
| `88bfd11`, `2b51172` | K-1/K-2: a project doesn't inherit QA_CREATE/AUTO_REWORK/AUTO_DONE; the toggles follow Kanban's `landing.mode: qa` and the kit's `qa.enabled`. Autoland decides on the effective agent. |
| `663b092`, `d2e3b3e` | Restart recovery resumes Claude cards too, with the resume note as the launch prompt (`--continue`), not the card prompt again. |

## Kit sha → archive sha

Kit (original) on the left, archive on the right, oldest first.

```
b9c1921 16879d1  60abaff d2fb30f  e3489ef 470427b  64834f2 16b4735  5d02e08 5266ea6  ee9fd03 accb937
a986271 ff4a76d  ca1327e 84ba1f7  697639a 9496770  4622da7 050d390  8756fc7 4d41fe5  46bf191 ddbc9ae
8256ac9 050492a  831c08f 8495ed2  fbb6308 28a2e5e  4d47434 4666e68  1596981 c09cd4b  bb3f712 a3f076e
9af01d4 8716bcb  7a65bc9 2e78c2a  dd23f6a cec38c1  34e1aa8 6dc9a6e  ccfcaca 0a3d1fc  232f105 3db96d0
f73f2fc ce33433  f3d86ce 12714b7  7c9847b 4e426fc  4f5040e 5a6c1ba  cfb8d20 66797d9  956e9e7 3fa8dd3
8ffce60 66b24f0  84de4af 264680f  cdcb87f 3e47f52  e9f4889 d9aaa7c  9296fb0 354466a  555fe16 4237849
d730b83 55444d4  a14b795 bf94846  b5744b3 d21ad72  6396ad9 d006846  6565283 a5a5cce  66273b4 d6c88c2
6809bfa afea137  215df86 359a871  2ca51b1 c5c42ec  229e94f 781442d  79b224e 834fbad  d067042 83aa4d0
2f906c2 daf86a5  9cd4ba3 ebde195  f95298b 519d05f  b3f3918 dc6e70d  555d426 9091f4b  86bedd6 e84c59e
c73b95a 0ce3398  bc8714f 603394f  f0dfc74 1964839  231ac52 b6bbe71  b909de5 a1056e9  53a60ae 22f8068
c1e3bdd 6db784f  5a4dc0e a7d9a76  23bc982 ebb2938  be41545 fc270f0  1633ea9 bd4eeff  eafc7af b52a684
3f71596 219fc1b  71f714a 8590bad  7dc0452 bf134c7  e7ad0ea a3b78a4  921edda 894c189  cd2ef16 158817d
ce7b672 d648e67  e2eb93d afe88e3  8d56898 8a1bf34  6819ce9 6be16bc  ab84492 20008b0  5e81759 692f174
31951a0 00a1c0d  f021821 01df7bb  28613f8 760fd36  7740cfd 4007b3b  e3bf665 85721ca  0384756 ebd5434
747347b 17ac007  9b1437c 86bee13  5a70ce4 a3a92b0  6a2ba0e d803265  6b61bfe 38f7227  e68d235 00325b6
8da24f0 056e2fc  ae21bbd 1a7a32a  c2add05 e3ab46f  9960570 6f6f826  d8bd8b8 0f713ad  9aa9131 a861b68
94277e4 67a0c44  14ed87b 7695b75  7272572 9675b6f  de83bf8 9bf260c  5126a5c 8a4f437  8c6dfed 9052c06
6ff9c53 2ffe609  60c5538 9101a29  bde015e 922b5b8  c637639 28b04a1  35b95ca acf45dc  2852764 6626852
7d08918 ef523b2  cc6ef30 0782636  666a084 b9dd99b  f019c5b 0bc6387  94247a7 1be18d1  d15bfbc 8e2fb5c
3b84abe 6698365  f9ed1c3 0261b20  7057bbd c8552ae  a01625e 1ce45df  d4834f8 cb27ad9  0a894c5 6da7159
cc1eefe 715c8a2  6f4fa93 282507c  4554284 15d7fe5  f859cb6 9716878  00514f2 3ddf550  92101ca 88bfd11
8ee0b1c c7e478a  ca9447e 114361e  9828540 2b51172  47d63ac 663b092  a2b4695 d2e3b3e
```

Dropped (price data only): `9794135`, `d41befc`, `bd3077d`, `cfbf3f4`, `6d05e78`, `edb3342`, `dc7d223`.
